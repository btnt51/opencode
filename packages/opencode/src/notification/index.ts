import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { TrustedHttp } from "@/util/trusted-http"
import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import path from "path"

export type Type = "attention" | "completed" | "failed" | "retry"

export type Notification = {
  type: Type
  sessionID: string
  project: string
  sessionTitle: string
  identity: string
  message?: string
  duration?: number
  attempt?: number
  next?: number
}

export interface Provider {
  readonly send: (notification: Notification) => Effect.Effect<void>
  readonly proxied?: boolean
}

type TelegramConfig = NonNullable<ConfigV1.Info["notification"]>[string]
type Events = NonNullable<TelegramConfig["events"]>

export function duration(input: string) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(input)
  if (!match) throw new Error(`Invalid notification duration: ${input}`)
  return Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2]] ?? 0)
}

export function format(notification: Notification) {
  const heading = {
    attention: notification.message?.startsWith("Question:")
      ? "OpenCode is waiting for input"
      : "OpenCode requires attention",
    completed: "OpenCode: task completed",
    failed: "OpenCode: task failed",
    retry: "OpenCode: retrying",
  }[notification.type]
  const lines = [heading, "", `Project: ${notification.project}`, `Session: ${notification.sessionTitle}`]
  if (notification.duration !== undefined) lines.push(`Duration: ${formatDuration(notification.duration)}`)
  if (notification.attempt !== undefined) lines.push(`Attempt: ${notification.attempt}`)
  if (notification.next !== undefined)
    lines.push(`Next retry: ${formatDuration(Math.max(0, notification.next - Date.now()))}`)
  if (notification.message) lines.push("", truncate(notification.message, 1_500))
  return truncate(lines.join("\n"), 3_500)
}

export function telegram(http: HttpClient.HttpClient, config: TelegramConfig, proxied = false): Provider {
  return {
    proxied,
    send: (notification) =>
      telegramRequest(config, notification).pipe(
        Effect.flatMap((request) => HttpClient.filterStatusOk(http).execute(request)),
        Effect.timeout("10 seconds"),
        Effect.asVoid,
      ),
  }
}

export function telegramRequest(config: TelegramConfig, notification: Notification) {
  return HttpClientRequest.post(`https://api.telegram.org/bot${config.botToken}/sendMessage`).pipe(
    HttpClientRequest.bodyJson({ chat_id: config.chatId, text: format(notification) }),
  )
}

type SessionState = { busySince?: number; pending: Set<string>; failed?: { identity: string; message: string } }

export function engine(input: {
  providers: ReadonlyArray<{ provider: Provider; events?: Events }>
  metadata: (sessionID: string) => Effect.Effect<{ project: string; sessionTitle: string }>
  now?: () => number
}) {
  const sessions = new Map<string, SessionState>()
  const sent = new Map<string, number>()
  const now = input.now ?? Date.now

  const dispatch = (notification: Notification) =>
    Effect.gen(function* () {
      const key = `${notification.sessionID}:${notification.type}:${notification.identity}`
      const previous = sent.get(key)
      if (previous !== undefined && now() - previous < 30_000) return
      sent.set(key, now())
      yield* Effect.forEach(
        input.providers.filter(
          (item) =>
            enabled(item.events, notification.type) &&
            (notification.type !== "completed" || (notification.duration ?? 0) >= threshold(item.events)),
        ),
        (item) =>
          item.provider.send(notification).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("notification delivery failed", {
                provider: "telegram",
                transport: item.provider.proxied ? "configured proxy" : "direct",
                type: notification.type,
                sessionID: notification.sessionID,
              }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      )
    })

  const notify = (partial: Omit<Notification, "project" | "sessionTitle">) =>
    Effect.gen(function* () {
      const metadata = yield* input.metadata(partial.sessionID)
      yield* dispatch({ ...partial, ...metadata })
    })

  const handle = (event: EventV2.Payload) =>
    Effect.gen(function* () {
      const data = event.data as Record<string, unknown>
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
      if (!sessionID) return
      const state = sessions.get(sessionID) ?? { pending: new Set<string>() }
      sessions.set(sessionID, state)

      if (event.type === PermissionV1.Event.Asked.type) {
        const request = event.data as EventV2.Data<typeof PermissionV1.Event.Asked>
        state.pending.add(request.id)
        yield* notify({
          type: "attention",
          sessionID,
          identity: request.id,
          message: `Permission requested:\n${truncate(request.permission, 100)}\n\n${truncate(request.patterns.join("\n"), 600)}`,
        })
        return
      }
      if (event.type === QuestionV1.Event.Asked.type) {
        const request = event.data as EventV2.Data<typeof QuestionV1.Event.Asked>
        state.pending.add(request.id)
        const question = request.questions[0]
        const options = question?.options
          .slice(0, 5)
          .map((option) => `- ${option.label}`)
          .join("\n")
        yield* notify({
          type: "attention",
          sessionID,
          identity: request.id,
          message: `Question:\n${truncate(question?.question ?? "Input requested", 600)}${options ? `\n\n${options}` : ""}`,
        })
        return
      }
      if (
        event.type === PermissionV1.Event.Replied.type ||
        event.type === QuestionV1.Event.Replied.type ||
        event.type === QuestionV1.Event.Rejected.type
      ) {
        if (typeof data.requestID === "string") state.pending.delete(data.requestID)
        return
      }
      if (event.type === SessionV1.Event.Error.type) {
        state.failed = { identity: event.id, message: `Error:\n${truncate(errorText(data.error), 800)}` }
        return
      }
      if (event.type !== SessionStatusEvent.Status.type) return
      const status = (event.data as EventV2.Data<typeof SessionStatusEvent.Status>).status
      if (status.type === "busy") {
        if (state.busySince !== undefined) state.failed = undefined
        state.busySince ??= now()
        return
      }
      if (status.type === "retry") {
        yield* notify({
          type: "retry",
          sessionID,
          identity: String(status.attempt),
          attempt: status.attempt,
          next: status.next,
          message: truncate(status.message, 500),
        })
        return
      }
      if (state.busySince === undefined) return
      const elapsed = now() - state.busySince
      state.busySince = undefined
      if (state.failed) {
        const failure = state.failed
        state.failed = undefined
        yield* notify({ type: "failed", sessionID, identity: failure.identity, message: failure.message })
        return
      }
      if (state.pending.size) return
      yield* notify({ type: "completed", sessionID, identity: String(now()), duration: elapsed })
    })

  return { handle }
}

function enabled(events: Events | undefined, type: Type) {
  const value = events?.[type]
  if (value === undefined) return type !== "retry"
  if (typeof value === "boolean") return value
  return value.enabled
}

function threshold(events: Events | undefined) {
  const value = events?.completed
  if (!value || typeof value === "boolean") return 0
  return value.after ? duration(value.after) : 0
}

function truncate(value: string, size: number) {
  const clean = value.replaceAll(/\{env:[^}]+\}/g, "[redacted]").replaceAll(/[\r\0]/g, "")
  return clean.length <= size ? clean : clean.slice(0, size - 1) + "…"
}

function errorText(value: unknown) {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string")
    return value.message
  return "Session failed"
}

function formatDuration(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Notification") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const events = yield* EventV2.Service
    const http = yield* HttpClient.HttpClient
    const session = yield* Session.Service
    const state = yield* InstanceState.make(
      Effect.fn("Notification.state")(function* (ctx) {
        const configured = Object.values((yield* config.get()).notification ?? {}).filter(
          (item) => item.enabled !== false,
        )
        const providers = yield* Effect.forEach(configured, function* (item) {
          const transport = yield* TrustedHttp.client({
            direct: http,
            proxy: item.proxy,
            destination: "https://api.telegram.org",
          })
          return { provider: telegram(transport.client, item, transport.proxied), events: item.events }
        })
        const service = engine({
          providers,
          metadata: (sessionID) =>
            session.get(sessionID as never).pipe(
              Effect.map((info) => ({ project: path.basename(ctx.worktree), sessionTitle: info.title || sessionID })),
              Effect.orElseSucceed(() => ({ project: path.basename(ctx.worktree), sessionTitle: sessionID })),
            ),
        })
        const unsubscribe = yield* events.listen(service.handle)
        yield* Effect.addFinalizer(() => unsubscribe)
        return true
      }),
    )
    return Service.of({ init: () => InstanceState.get(state).pipe(Effect.asVoid) })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node, EventV2.node, Session.node] })

export * as Notification from "."
