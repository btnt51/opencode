import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Sandbox } from "@opencode/core/sandbox"
import { Document, Info } from "@opencode/schema/config"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const layer = (sandbox: Info["sandbox"]) =>
  AppNodeBuilder.build(LayerNode.group([Sandbox.node, Location.node]), [
    Location.node.replace(tempLocationLayer),
    Config.node.replace(Config.testLayer([new Document({ type: "document", info: new Info({ sandbox }) })])),
  ])

it.live("enforces workspace, external roots, denies, and symlink canonical paths", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const sandbox = yield* Sandbox.Service
    const outside = yield* tmpdirScoped("opencode-sandbox-outside-")
    const inside = path.join(location.directory, "inside")
    yield* Effect.promise(() => fs.mkdir(inside))
    yield* sandbox.read(inside)
    yield* sandbox.write(path.join(inside, "new.txt"))
    expect(yield* sandbox.read(path.join(outside.path, "secret.txt")).pipe(Effect.flip)).toBeInstanceOf(Sandbox.Denied)
    yield* Effect.promise(() => fs.symlink(outside.path, path.join(inside, "escape")))
    expect(yield* sandbox.read(path.join(inside, "escape")).pipe(Effect.flip)).toBeInstanceOf(Sandbox.Denied)
    expect(yield* sandbox.write(path.join(inside, "escape", "new.txt")).pipe(Effect.flip)).toBeInstanceOf(
      Sandbox.Denied,
    )
  }).pipe(Effect.provide(layer(true))),
)

it.live("applies deny before the default workspace allow", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const sandbox = yield* Sandbox.Service
    const denied = path.join(location.directory, "private")
    yield* Effect.promise(() => fs.mkdir(denied))
    expect(yield* sandbox.read(denied).pipe(Effect.flip)).toBeInstanceOf(Sandbox.Denied)
  }).pipe(Effect.provide(layer({ filesystem: { deny: ["private"] } }))),
)

it.live("filters process environment and keeps full network scoped to bwrap", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const sandbox = yield* Sandbox.Service
    const command = yield* sandbox.command(
      ChildProcess.make("/bin/echo", ["ok"], {
        cwd: location.directory,
        env: { PATH: "/usr/bin", OPENCODE_TEST_SECRET: "hidden" },
        extendEnv: true,
      }),
    )
    expect(command._tag).toBe("StandardCommand")
    if (command._tag !== "StandardCommand") return
    expect(command.command).toBe("bwrap")
    expect(command.args).toContain("--share-net")
    expect(command.options.extendEnv).toBe(false)
    expect(command.options.env?.PATH).toBe("/usr/bin")
    expect(command.options.env?.OPENCODE_TEST_SECRET).toBeUndefined()
    expect(command.options.env?.HOME).toBeUndefined()
  }).pipe(Effect.provide(layer({ network: true }))),
)

it.live("preserves commands unchanged when sandbox is disabled", () =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.Service
    const original = ChildProcess.make("echo", ["legacy"], { extendEnv: true })
    expect(yield* sandbox.command(original)).toBe(original)
  }).pipe(Effect.provide(layer(false))),
)

it.live("freezes effective policy across config replacement", () =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.Service
    const config = yield* Config.Test
    yield* config.setEntries([new Document({ type: "document", info: new Info({ sandbox: false }) })])
    expect(sandbox.policy.enabled).toBe(true)
    expect(yield* sandbox.read("/outside-after-reload").pipe(Effect.flip)).toBeInstanceOf(Sandbox.Denied)
  }).pipe(Effect.provide(layer(true))),
)
