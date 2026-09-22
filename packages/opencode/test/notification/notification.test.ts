import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { Notification } from "@/notification"
import { Effect } from "effect"

const event = (type: string, data: Record<string, unknown>, id = `${type}-1`) =>
  ({ id, type, data }) as unknown as EventV2.Payload

describe("notification", () => {
  test("parses supported durations and rejects invalid values", () => {
    expect(Notification.duration("5s")).toBe(5_000)
    expect(Notification.duration("2m")).toBe(120_000)
    expect(Notification.duration("1h")).toBe(3_600_000)
    expect(() => Notification.duration("soon")).toThrow("Invalid notification duration")
  })

  test("deduplicates attention by request identity without hiding separate requests", async () => {
    const received: Notification.Notification[] = []
    const service = Notification.engine({
      providers: [{ provider: { send: (value) => Effect.sync(() => received.push(value)) } }],
      metadata: () => Effect.succeed({ project: "opencode", sessionTitle: "Trusted notifications" }),
    })
    const request = {
      sessionID: "ses_one",
      id: "per_one",
      permission: "bash",
      patterns: ["echo ok"],
      metadata: {},
      always: [],
    }
    await Effect.runPromise(service.handle(event("permission.asked", request)))
    await Effect.runPromise(service.handle(event("permission.asked", request, "duplicate-event")))
    await Effect.runPromise(service.handle(event("permission.asked", { ...request, id: "per_two" }, "separate-event")))
    expect(received.map((item) => item.identity)).toEqual(["per_one", "per_two"])
    expect(received[0]?.message).toContain("bash")
  })

  test("question requests produce attention notifications", async () => {
    const received: Notification.Notification[] = []
    const service = Notification.engine({
      providers: [{ provider: { send: (value) => Effect.sync(() => received.push(value)) } }],
      metadata: () => Effect.succeed({ project: "opencode", sessionTitle: "Questions" }),
    })
    await Effect.runPromise(
      service.handle(
        event("question.asked", {
          sessionID: "ses_one",
          id: "que_one",
          questions: [{ question: "Which backend?", header: "Backend", options: [{ label: "Bun", description: "" }] }],
        }),
      ),
    )
    expect(received).toHaveLength(1)
    expect(received[0]?.message).toContain("Which backend?")
  })

  test("tracks completion lifecycle, threshold, pending attention, and concurrent sessions", async () => {
    const received: Notification.Notification[] = []
    let now = 0
    const service = Notification.engine({
      providers: [
        {
          provider: { send: (value) => Effect.sync(() => received.push(value)) },
          events: { completed: { enabled: true, after: "30s" } },
        },
      ],
      metadata: (sessionID) => Effect.succeed({ project: "opencode", sessionTitle: sessionID }),
      now: () => now,
    })
    await Effect.runPromise(service.handle(event("session.status", { sessionID: "initial", status: { type: "idle" } })))
    await Effect.runPromise(service.handle(event("session.status", { sessionID: "short", status: { type: "busy" } })))
    now = 10_000
    await Effect.runPromise(service.handle(event("session.status", { sessionID: "short", status: { type: "idle" } })))
    await Effect.runPromise(service.handle(event("session.status", { sessionID: "long", status: { type: "busy" } })))
    now = 15_000
    await Effect.runPromise(service.handle(event("session.status", { sessionID: "other", status: { type: "busy" } })))
    await Effect.runPromise(
      service.handle(
        event("question.asked", {
          sessionID: "other",
          id: "que_wait",
          questions: [{ question: "Continue?", header: "Continue", options: [] }],
        }),
      ),
    )
    now = 45_000
    await Effect.runPromise(service.handle(event("session.status", { sessionID: "long", status: { type: "idle" } })))
    now = 60_000
    await Effect.runPromise(service.handle(event("session.status", { sessionID: "other", status: { type: "idle" } })))
    expect(received.filter((item) => item.type === "completed").map((item) => item.sessionID)).toEqual(["long"])
  })

  test("terminal errors notify on idle while recoverable errors followed by busy do not", async () => {
    const received: Notification.Notification[] = []
    const service = Notification.engine({
      providers: [{ provider: { send: (value) => Effect.sync(() => received.push(value)) } }],
      metadata: () => Effect.succeed({ project: "opencode", sessionTitle: "Failure" }),
    })
    await Effect.runPromise(
      service.handle(event("session.status", { sessionID: "terminal", status: { type: "busy" } })),
    )
    await Effect.runPromise(
      service.handle(event("session.error", { sessionID: "terminal", error: { message: "gave up" } })),
    )
    await Effect.runPromise(
      service.handle(event("session.status", { sessionID: "terminal", status: { type: "idle" } })),
    )
    await Effect.runPromise(service.handle(event("session.status", { sessionID: "recover", status: { type: "busy" } })))
    await Effect.runPromise(
      service.handle(event("session.error", { sessionID: "recover", error: { message: "retryable" } })),
    )
    await Effect.runPromise(service.handle(event("session.status", { sessionID: "recover", status: { type: "busy" } })))
    await Effect.runPromise(service.handle(event("session.status", { sessionID: "recover", status: { type: "idle" } })))
    expect(received.filter((item) => item.type === "failed").map((item) => item.sessionID)).toEqual(["terminal"])
  })

  test("retry is disabled by default and identity-deduplicated when enabled", async () => {
    const disabled: Notification.Notification[] = []
    const enabled: Notification.Notification[] = []
    const service = Notification.engine({
      providers: [
        { provider: { send: (value) => Effect.sync(() => disabled.push(value)) } },
        { provider: { send: (value) => Effect.sync(() => enabled.push(value)) }, events: { retry: true } },
      ],
      metadata: () => Effect.succeed({ project: "opencode", sessionTitle: "Retry" }),
    })
    const retry = event("session.status", {
      sessionID: "ses_retry",
      status: { type: "retry", attempt: 3, message: "rate limited", next: 10_000 },
    })
    await Effect.runPromise(service.handle(retry))
    await Effect.runPromise(service.handle(retry))
    expect(disabled).toHaveLength(0)
    expect(enabled).toHaveLength(1)
  })

  test("provider failures remain best effort", async () => {
    const service = Notification.engine({
      providers: [{ provider: { send: () => Effect.fail(new Error("secret-token")) } }],
      metadata: () => Effect.succeed({ project: "opencode", sessionTitle: "Best effort" }),
    })
    await expect(
      Effect.runPromise(
        service.handle(
          event("permission.asked", {
            sessionID: "ses_one",
            id: "per_one",
            permission: "bash",
            patterns: [],
            metadata: {},
            always: [],
          }),
        ),
      ),
    ).resolves.toBeUndefined()
  })

  test("builds the Telegram Bot API request with bounded plain text", async () => {
    const request = await Effect.runPromise(
      Notification.telegramRequest(
        { type: "telegram", enabled: true, botToken: "test-token", chatId: "123" },
        {
          type: "completed",
          sessionID: "ses_one",
          project: "opencode",
          sessionTitle: "Notifications",
          identity: "done",
          duration: 30_000,
        },
      ),
    )
    expect(request.url).toBe("https://api.telegram.org/bottest-token/sendMessage")
    expect(request.body._tag).toBe("Uint8Array")
    if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request body")
    const body = new TextDecoder().decode(request.body.body)
    expect(body).toContain('"chat_id":"123"')
    expect(body).toContain("OpenCode: task completed")
  })
})
