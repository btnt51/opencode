export * as NotificationPlugin from "./notification.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Form } from "@opencode/schema/form"
import { Permission } from "@opencode/schema/permission"
import { SessionEvent } from "@opencode/schema/session-event"
import { Effect, Semaphore, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Config } from "../config.js"
import { ConfigEntryObserver } from "../config/plugin/entry-observer.js"
import { Notification } from "../notification.js"
import { Session } from "../session.js"

const CAPACITY = 128
const CONCURRENCY = 4

export const Plugin = define({
  id: "opencode.notification",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient
    const sessions = yield* Session.Service
    const delivery = Semaphore.makeUnsafe(CONCURRENCY)
    const state = {
      destinations: [] as readonly Notification.Destination[],
      queued: 0,
      starts: new Map<string, { id: string; created: number }>(),
      pending: new Map<string, Set<string>>(),
      delivered: new Set<string>(),
    }
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      Effect.sync(() => reload()),
    )
    function reload() {
      const configured = Object.assign(
        {},
        ...loaded.entries.flatMap((entry) =>
          entry.type === "document" && entry.info.notification ? [entry.info.notification] : [],
        ),
      )
      state.destinations = Notification.destinations(configured, http)
    }
    reload()

    const enqueue = Effect.fnUntraced(function* (
      destination: Notification.Destination,
      key: string,
      message: Notification.Message,
    ) {
      const identity = `${destination.name}:${message.session.location.directory}:${message.session.id}:${key}`
      if (state.delivered.has(identity) || state.queued >= CAPACITY) return
      if (state.delivered.size >= 2_048) state.delivered.delete(state.delivered.values().next().value!)
      state.delivered.add(identity)
      state.queued++
      yield* delivery
        .withPermits(1)(
          destination.provider.send(message).pipe(
            Effect.catch((error) =>
              Effect.logWarning("notification delivery failed", {
                destination: error.destination,
                reason: error.reason,
              }),
            ),
            Effect.ensuring(Effect.sync(() => state.queued--)),
          ),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }))
    })

    const notify = Effect.fnUntraced(function* (
      kind: Notification.Kind,
      sessionID: Session.Info["id"],
      key: string,
      options?: { readonly subject?: "permission" | "form"; readonly elapsed?: number },
    ) {
      const session = yield* sessions.get(sessionID).pipe(Effect.option)
      if (session._tag === "None" || session.value.parentID) return
      yield* Effect.forEach(state.destinations, (destination) => {
        if (!destination.events[kind]) return Effect.void
        if (kind === "completed" && (options?.elapsed ?? 0) < destination.events.completedAfter) return Effect.void
        return enqueue(destination, key, { kind, session: session.value, ...options })
      })
    })

    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        if (event.type === Permission.Event.Asked.type) {
          const pending = state.pending.get(event.data.sessionID) ?? new Set<string>()
          pending.add(event.data.id)
          state.pending.set(event.data.sessionID, pending)
          return notify("attention", event.data.sessionID, `permission:${event.data.id}`, { subject: "permission" })
        }
        if (event.type === Permission.Event.Replied.type) {
          state.pending.get(event.data.sessionID)?.delete(event.data.requestID)
          return Effect.void
        }
        if (event.type === Form.Event.Created.type) {
          if (event.data.form.sessionID === "global") return Effect.void
          const sessionID = Session.ID.make(event.data.form.sessionID)
          const pending = state.pending.get(sessionID) ?? new Set<string>()
          pending.add(event.data.form.id)
          state.pending.set(sessionID, pending)
          return notify("attention", sessionID, `form:${event.data.form.id}`, { subject: "form" })
        }
        if (event.type === Form.Event.Replied.type || event.type === Form.Event.Cancelled.type) {
          if (event.data.sessionID !== "global") state.pending.get(event.data.sessionID)?.delete(event.data.id)
          return Effect.void
        }
        if (event.type === SessionEvent.Execution.Started.type) {
          state.starts.set(event.data.sessionID, { id: event.id, created: event.created })
          return Effect.void
        }
        if (event.type === SessionEvent.Execution.Succeeded.type) {
          const start = state.starts.get(event.data.sessionID)
          state.starts.delete(event.data.sessionID)
          if (!start || state.pending.get(event.data.sessionID)?.size) return Effect.void
          return notify("completed", event.data.sessionID, `execution:${start.id}:succeeded`, {
            elapsed: Math.max(0, event.created - start.created),
          })
        }
        if (event.type === SessionEvent.Execution.Failed.type) {
          const start = state.starts.get(event.data.sessionID)
          state.starts.delete(event.data.sessionID)
          return notify("failed", event.data.sessionID, `execution:${start?.id ?? event.id}:failed`)
        }
        if (event.type === SessionEvent.Execution.Interrupted.type) state.starts.delete(event.data.sessionID)
        return Effect.void
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
