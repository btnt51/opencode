export * as ConfigNotificationV1 from "./notification"

import { Schema } from "effect"

export const Duration = Schema.String.check(
  Schema.makeFilter((value) => /^\d+(?:\.\d+)?(?:ms|s|m|h)$/.test(value), {
    message: "Expected a duration such as 5s, 30s, 2m, or 1h",
  }),
).annotate({ description: "Minimum task duration before notification (for example 30s, 2m, or 1h)" })

const Toggle = Schema.Union([Schema.Boolean, Schema.Struct({ enabled: Schema.Boolean })])

const ProxyUrl = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      if (!URL.canParse(value)) return false
      const protocol = new URL(value).protocol
      return protocol === "http:" || protocol === "https:"
    },
    { message: "Expected an HTTP or HTTPS proxy URL" },
  ),
)

export const Proxy = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("direct") }),
  Schema.Struct({ mode: Schema.Literal("environment") }),
  Schema.Struct({ mode: Schema.Literal("url"), url: ProxyUrl }),
]).annotate({ description: "Proxy used only for this trusted notification destination" })

export const Telegram = Schema.Struct({
  type: Schema.Literal("telegram"),
  enabled: Schema.optional(Schema.Boolean),
  botToken: Schema.optional(Schema.String),
  chatId: Schema.optional(Schema.String),
  proxy: Schema.optional(Proxy),
  events: Schema.optional(
    Schema.Struct({
      attention: Schema.optional(Toggle),
      completed: Schema.optional(
        Schema.Union([Schema.Boolean, Schema.Struct({ enabled: Schema.Boolean, after: Schema.optional(Duration) })]),
      ),
      failed: Schema.optional(Toggle),
      retry: Schema.optional(Toggle),
    }),
  ),
}).pipe(
  Schema.check(
    Schema.makeFilter((value) => value.enabled === false || Boolean(value.botToken), {
      message: "Enabled Telegram notification providers require botToken",
    }),
    Schema.makeFilter((value) => value.enabled === false || Boolean(value.chatId), {
      message: "Enabled Telegram notification providers require chatId",
    }),
  ),
)

export const Info = Schema.Record(Schema.String, Telegram).annotate({
  description: "Trusted notification providers keyed by destination name",
})
