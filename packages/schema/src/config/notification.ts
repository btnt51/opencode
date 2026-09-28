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

export const Telegram = Schema.Struct({
  type: Schema.Literal("telegram"),
  enabled: Schema.Boolean.pipe(optional),
  botToken: Schema.String,
  chatId: Schema.String,
  // Reserved for the per-destination proxy stage. Runtime rejects it rather than silently using direct transport.
  proxy: Schema.String.pipe(optional),
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
