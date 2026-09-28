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

it.live("separates provider and MCP infrastructure policy from tool networking", () =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.Service
    expect(sandbox.policy.network).toBe("none")
    expect(sandbox.policy.provider).toBe("disabled")
    yield* sandbox.mcp("company")
    expect(yield* sandbox.mcp("denied").pipe(Effect.flip)).toMatchObject({
      path: "denied",
      reason: "MCP server is not allowed by sandbox policy",
    })
  }).pipe(Effect.provide(layer({ network: { tools: "none", provider: "disabled", mcp: { allow: ["company"] } } }))),
)

it.live("defaults provider to configured and the MCP allowlist to empty", () =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.Service
    expect(sandbox.policy.provider).toBe("configured")
    expect(yield* sandbox.mcp("company").pipe(Effect.flip)).toBeInstanceOf(Sandbox.Denied)
  }).pipe(Effect.provide(layer(true))),
)

it.live("builds a restricted policy without treating an empty allowlist as full or none", () =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.Service
    expect(sandbox.policy.network).toEqual({ allow: [] })
    expect(yield* sandbox.network("webfetch").pipe(Effect.flip)).toMatchObject({
      reason: "in-process network tools are unsupported in restricted mode",
    })
  }).pipe(Effect.provide(layer({ network: { tools: { mode: "restricted", allow: [] } } }))),
)

it.live("injects only the namespace relay proxy and redacts host proxy credentials", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const sandbox = yield* Sandbox.Service
    const command = yield* sandbox.command(
      ChildProcess.make("/bin/echo", ["ok"], {
        cwd: location.directory,
        env: { ALL_PROXY: "http://user:secret@host-proxy.example:8080" },
      }),
    )
    if (command._tag !== "StandardCommand") return
    expect(command.args).not.toContain("--share-net")
    expect(command.args).toContain("/run/opencode-network/relay.py")
    expect(command.options.env?.ALL_PROXY).toBeUndefined()
    expect(command.options.env?.HTTPS_PROXY).toBe("http://127.0.0.1:18080")
  }).pipe(
    Effect.provide(
      layer({
        environment: "all",
        network: { tools: { mode: "restricted", allow: [{ host: "github.com", ports: [443] }] } },
      }),
    ),
  ),
)

it.live("isolates local MCP networking while preserving only its explicit environment", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const sandbox = yield* Sandbox.Service
    const command = yield* sandbox.localMcpCommand(
      ChildProcess.make("/bin/echo", ["ok"], {
        cwd: location.directory,
        env: { MCP_EXPLICIT: "visible", OPENCODE_PROVIDER_KEY: "hidden" },
        extendEnv: true,
      }),
      "none",
    )
    if (command._tag !== "StandardCommand") return
    expect(command.command).toBe("bwrap")
    expect(command.args).not.toContain("--share-net")
    expect(command.options.extendEnv).toBe(false)
    expect(command.options.env?.MCP_EXPLICIT).toBe("visible")
    expect(command.options.env?.OPENCODE_PROVIDER_KEY).toBe("hidden")
    expect(command.options.env?.HOME).toBeUndefined()
  }).pipe(Effect.provide(layer(true))),
)
