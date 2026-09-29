export * as Notification from "./notification.js"

import { ConfigNotification } from "@opencode/schema/config/notification"
import type { Session } from "@opencode/schema/session"
import { NodeHttpClient } from "@effect/platform-node"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
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
      const selected = yield* Effect.try({
        try: () => proxy(endpoint, config.proxy),
        catch: () => new TransportError({ destination: name, reason: "invalid proxy configuration" }),
      })
      const response = yield* (selected ? proxyClient(selected) : Effect.succeed(http)).pipe(
        Effect.flatMap((client) => HttpClient.withScope(client).execute(request)),
      )
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

type Environment = Readonly<Record<string, string | undefined>>

export function environmentProxy(destination: string, environment: Environment = process.env) {
  const url = new URL(destination)
  if (bypassesProxy(url, environmentValue(environment, "no_proxy", "NO_PROXY"))) return undefined
  const names = url.protocol === "https:" ? ["https_proxy", "HTTPS_PROXY"] : ["http_proxy", "HTTP_PROXY"]
  return [...names, "all_proxy", "ALL_PROXY"].map((name) => environment[name]?.trim()).find(Boolean)
}

function proxy(destination: string, config: ConfigNotification.Proxy | undefined) {
  if (!config || config.mode === "direct") return undefined
  const selected = config.mode === "url" ? config.url : environmentProxy(destination)
  if (!selected) return undefined
  if (!URL.canParse(selected)) throw new Error("notification proxy requires a valid http:// or https:// URL")
  const parsed = new URL(selected)
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname)
    throw new Error("notification proxy requires a valid http:// or https:// URL")
  return parsed
}

function proxyClient(proxy: URL) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const value = proxy.toString()
      return {
        http: new HttpProxyAgent(value),
        https: new HttpsProxyAgent(value),
      }
    }),
    (agents) =>
      Effect.sync(() => {
        agents.http.destroy()
        agents.https.destroy()
      }),
  ).pipe(
    Effect.flatMap((agents) =>
      NodeHttpClient.makeNodeHttp.pipe(Effect.provideService(NodeHttpClient.HttpAgent, agents)),
    ),
  )
}

function environmentValue(environment: Environment, lower: string, upper: string) {
  return environment[lower]?.trim() || environment[upper]?.trim() || undefined
}

function bypassesProxy(url: URL, value: string | undefined) {
  if (!value) return false
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  return value.split(/[\s,]+/).some((entry) => {
    if (!entry) return false
    if (entry === "*") return true
    const bracketed = entry.startsWith("[") ? entry.indexOf("]") : -1
    const separator = bracketed >= 0 ? bracketed + 1 : entry.lastIndexOf(":")
    const hasPort = separator >= 0 && entry[separator] === ":" && /^\d+$/.test(entry.slice(separator + 1))
    if (hasPort && entry.slice(separator + 1) !== port) return false
    const raw = hasPort ? entry.slice(0, separator) : entry
    const host = raw.replace(/^\[|\]$/g, "").toLowerCase()
    if (host.startsWith("*.")) return hostname.endsWith(host.slice(1)) && hostname !== host.slice(2)
    if (host.startsWith(".")) return hostname.endsWith(host) && hostname !== host.slice(1)
    return hostname === host
  })
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
