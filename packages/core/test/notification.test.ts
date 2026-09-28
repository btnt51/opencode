import { describe, expect } from "bun:test"
import { Notification } from "@opencode/core/notification"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ConfigNotification } from "@opencode/schema/config/notification"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { Schema } from "effect"
import { Effect, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { it } from "./lib/effect"

describe("Notification", () => {
  it.effect("applies destination defaults and completed threshold", () =>
    Effect.gen(function* () {
      const configured = Schema.decodeUnknownSync(ConfigNotification.Destinations)({
        personal: {
          type: "telegram",
          botToken: "token",
          chatId: "chat",
          events: { completed: { enabled: true, after: "30s" } },
        },
      })
      const destination = Notification.destinations(configured, successClient())[0]
      expect(destination?.events).toEqual({
        attention: true,
        completed: true,
        completedAfter: 30_000,
        failed: true,
        retry: false,
      })
    }),
  )

  it.effect("rejects unitless and negative durations", () =>
    Effect.sync(() => {
      expect(Schema.is(ConfigNotification.Duration)("30")).toBeFalse()
      expect(Schema.is(ConfigNotification.Duration)("-1s")).toBeFalse()
      expect(Schema.is(ConfigNotification.Duration)("0ms")).toBeTrue()
    }),
  )

  it.effect("sends minimal metadata and validates Bot API success", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<string[]>([])
      const client = HttpClient.make((request) =>
        Ref.update(requests, (items) => [...items, request.url]).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, Response.json({ ok: true }))),
        ),
      )
      const destination = Notification.destinations(
        { personal: { type: "telegram", botToken: "secret", chatId: "chat" } },
        client,
      )[0]!
      yield* destination.provider.send(message("attention"))
      expect(yield* Ref.get(requests)).toEqual(["https://api.telegram.org/botsecret/sendMessage"])
    }),
  )

  it.effect("reports HTTP and Bot API failures without exposing credentials", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ ok: false, description: "token secret" }, { status: 401 }),
          ),
        ),
      )
      const destination = Notification.destinations(
        { personal: { type: "telegram", botToken: "secret", chatId: "chat" } },
        client,
      )[0]!
      const error = yield* destination.provider.send(message("failed")).pipe(Effect.flip)
      expect(error.reason).toBe("HTTP 401")
      expect(JSON.stringify(error)).not.toContain("secret")
    }),
  )

  it.effect("rejects an unsuccessful Bot API JSON response", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ ok: false, description: "denied" }))),
      )
      const destination = Notification.destinations(
        { personal: { type: "telegram", botToken: "secret", chatId: "chat" } },
        client,
      )[0]!
      expect((yield* destination.provider.send(message("failed")).pipe(Effect.flip)).reason).toBe(
        "Telegram rejected request",
      )
    }),
  )

  it.effect("isolates malformed destinations", () =>
    Effect.sync(() => {
      const normalized = ConfigNormalize.normalize({
        notification: {
          broken: { type: "telegram", botToken: "" },
          personal: { type: "telegram", botToken: "secret", chatId: "chat" },
        },
      })
      expect(normalized.type).toBe("normalized")
      if (normalized.type === "rejected") return
      expect(Object.keys(normalized.encoded.notification as object)).toEqual(["personal"])
      expect(normalized.diagnostics).toContainEqual({
        kind: "invalid",
        path: ["notification", "broken"],
        message: "skipped malformed recognized value",
      })
    }),
  )

  it.effect("disables proxy destinations until proxy transport is supported", () =>
    Effect.sync(() => {
      expect(
        Notification.destinations(
          { personal: { type: "telegram", botToken: "secret", chatId: "chat", proxy: "http://proxy" } },
          successClient(),
        ),
      ).toEqual([])
    }),
  )
})

function successClient() {
  return HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ ok: true }, { status: 200 }))),
  )
}

function message(kind: Notification.Kind): Notification.Message {
  return {
    kind,
    subject: kind === "attention" ? "permission" : undefined,
    session: {
      id: Session.ID.make("ses_test"),
      title: "Test",
      projectID: Project.ID.make("prj_test"),
      location: Location.Ref.make({ directory: "/tmp/project" }),
    },
  }
}
