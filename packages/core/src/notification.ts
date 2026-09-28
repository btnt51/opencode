export * as Notification from "./notification.js"

import { ConfigNotification } from "@opencode/schema/config/notification"
import type { Session } from "@opencode/schema/session"
import { Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export type Kind = "attention" | "completed" | "failed" | "retry"

export interface Message {
  readonly kind: Kind
  readonly session: Pick<Session.Info, "id" | "title" | "projectID" | "location">
  readonly subject?: "permission" | "form"
  readonly elapsed?: number
}

export class TransportError extends Schema.TaggedError<TransportError>()("Notification.TransportError", {
  destination: Schema.String,
  reason: Schema.String,
}) {}

export interface Provider {
  readonly send: (message: Message) => Effect.Effect<void, TransportError>
}

export interface Destination {
  readonly name: string
  readonly provider: Provider
  readonly events: {
    readonly attention: boolean
    readonly completed: boolean
    readonly completedAfter: number
    readonly failed: boolean
    readonly retry: false
  }
}

const TelegramResponse = Schema.Struct({
  ok: Schema.Boolean,
  description: Schema.String.pipe(Schema.optional),
  parameters: Schema.Struct({ retry_after: Schema.Number.pipe(Schema.optional) }).pipe(Schema.optional),
})

export function destinations(
  configured: ConfigNotification.Destinations | undefined,
  http: HttpClient.HttpClient,
): readonly Destination[] {
  if (!configured) return []
  return Object.entries(configured).flatMap(([name, item]) => {
    if (item.enabled === false) return []
    if (!item.botToken.trim() || !item.chatId.trim()) {
      Effect.runFork(
        Effect.logWarning("notification destination disabled", { destination: name, reason: "missing credentials" }),
      )
      return []
    }
    if (item.proxy !== undefined) {
      Effect.runFork(
        Effect.logWarning("notification destination disabled", { destination: name, reason: "proxy is not supported" }),
      )
      return []
    }
    if (enabled(item.events?.retry, false))
      Effect.runFork(
        Effect.logWarning("notification retry event is unsupported", {
          destination: name,
          reason: "no V2 retry event",
        }),
      )
    return [
      {
        name,
        provider: telegram(name, item, http),
        events: {
          attention: enabled(item.events?.attention, true),
          completed: enabled(item.events?.completed, true),
          completedAfter:
            typeof item.events?.completed === "object" && item.events.completed.after
              ? duration(item.events.completed.after)
              : 0,
          failed: enabled(item.events?.failed, true),
          retry: false as const,
        },
      },
    ]
  })
}

function telegram(name: string, config: ConfigNotification.Telegram, http: HttpClient.HttpClient): Provider {
  const endpoint = `https://api.telegram.org/bot${config.botToken}/sendMessage`
  const send = (message: Message, retry = true): Effect.Effect<void, TransportError> =>
    Effect.gen(function* () {
      const request = yield* HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.schemaBodyJson(Schema.Struct({ chat_id: Schema.String, text: Schema.String }))({
          chat_id: config.chatId,
          text: format(message),
        }),
      )
      const response = yield* HttpClient.withScope(http).execute(request)
      const body = yield* HttpClientResponse.schemaBodyJson(TelegramResponse)(response)
      if (response.status === 429 && retry) {
        yield* Effect.sleep(Duration.seconds(Math.min(5, Math.max(1, body.parameters?.retry_after ?? 1))))
        return yield* send(message, false)
      }
      if (response.status < 200 || response.status >= 300)
        return yield* new TransportError({ destination: name, reason: `HTTP ${response.status}` })
      if (!body.ok)
        return yield* new TransportError({
          destination: name,
          reason: body.description ? "Telegram rejected request" : "invalid response",
        })
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.fail(new TransportError({ destination: name, reason: "timeout" })),
      }),
      Effect.catch((error) =>
        error instanceof TransportError
          ? Effect.fail(error)
          : Effect.fail(new TransportError({ destination: name, reason: "transport failure" })),
      ),
    )
  return { send: (message) => send(message) }
}

function format(message: Message) {
  const title = (message.session.title?.trim() || message.session.id).slice(0, 160)
  const project = message.session.location.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? message.session.projectID
  const detail =
    message.kind === "attention"
      ? message.subject === "form"
        ? "Input requested"
        : "Permission requested"
      : message.kind === "completed"
        ? "Execution succeeded"
        : message.kind === "failed"
          ? "Execution failed"
          : "Execution retry"
  return [`OpenCode: ${detail}`, `Session: ${title}`, `Project: ${project.slice(0, 160)}`].join("\n").slice(0, 800)
}

function enabled(value: ConfigNotification.Event | ConfigNotification.Completed | undefined, fallback: boolean) {
  if (value === undefined) return fallback
  if (typeof value === "boolean") return value
  return value.enabled
}

function duration(value: ConfigNotification.Duration) {
  const amount = Number.parseInt(value, 10)
  if (value.endsWith("ms")) return amount
  if (value.endsWith("s")) return amount * 1_000
  if (value.endsWith("m")) return amount * 60_000
  return amount * 3_600_000
}
