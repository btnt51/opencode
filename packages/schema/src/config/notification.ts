export * as ConfigNotification from "./notification.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export const Duration = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d*)(?:ms|s|m|h)$/)).annotate({
  identifier: "Config.Notification.Duration",
  description: "A non-negative duration with an ms, s, m, or h unit",
})
export type Duration = typeof Duration.Type

export const Event = Schema.Union([Schema.Boolean, Schema.Struct({ enabled: Schema.Boolean })]).annotate({
  identifier: "Config.Notification.Event",
})
export type Event = typeof Event.Type

export const Completed = Schema.Union([
  Schema.Boolean,
  Schema.Struct({ enabled: Schema.Boolean, after: Duration.pipe(optional) }),
]).annotate({ identifier: "Config.Notification.Completed" })
export type Completed = typeof Completed.Type

const ProxyUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!URL.canParse(value)) return "expected a valid proxy URL"
    const url = new URL(value)
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) return undefined
    return "expected an http:// or https:// proxy URL with a hostname"
  }),
)

export const Proxy = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("direct") }),
  Schema.Struct({ mode: Schema.Literal("environment") }),
  Schema.Struct({
    mode: Schema.Literal("url"),
    url: ProxyUrl,
  }),
]).annotate({
  identifier: "Config.Notification.Proxy",
  description:
    "Connection policy for this destination. Environment reads proxy variables on the trusted backend host (127.0.0.1 is that host, not a remote workspace or the user's computer); PAC and OS proxy settings are not used.",
})
export type Proxy = typeof Proxy.Type

export const Telegram = Schema.Struct({
  type: Schema.Literal("telegram"),
  enabled: Schema.Boolean.pipe(optional),
  botToken: Schema.String,
  chatId: Schema.String,
  proxy: Proxy.pipe(optional),
  events: Schema.Struct({
    attention: Event.pipe(optional),
    completed: Completed.pipe(optional),
    failed: Event.pipe(optional),
    retry: Event.pipe(optional),
  }).pipe(optional),
}).annotate({ identifier: "Config.Notification.Telegram" })
export type Telegram = typeof Telegram.Type

export const Destinations = Schema.Record(Schema.String, Telegram).annotate({
  identifier: "Config.Notification.Destinations",
})
export type Destinations = typeof Destinations.Type
