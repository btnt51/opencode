export * as Sandbox from "./sandbox.js"

import fs from "node:fs/promises"
import path from "node:path"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "./config.js"
import { Location } from "./location.js"
import { AbsolutePath } from "./schema.js"
import { SandboxNetwork } from "./sandbox/network.js"

export class Denied extends Schema.TaggedError<Denied>()("Sandbox.Denied", {
  operation: Schema.Literals(["read", "write", "execute", "network"]),
  path: Schema.String,
  reason: Schema.String,
}) {}

export interface Policy {
  readonly enabled: boolean
  readonly workspace: AbsolutePath
  readonly read: readonly AbsolutePath[]
  readonly write: readonly AbsolutePath[]
  readonly deny: readonly AbsolutePath[]
  readonly network: "none" | "full" | SandboxNetwork.Policy
  readonly provider: "configured" | "disabled"
  readonly mcp: ReadonlySet<string>
  readonly environment: "safe" | "all"
}

export interface Interface {
  readonly policy: Policy
  readonly read: (target: string) => Effect.Effect<void, Denied>
  readonly write: (target: string) => Effect.Effect<void, Denied>
  readonly command: (command: ChildProcess.Command) => Effect.Effect<ChildProcess.Command, Denied>
  readonly network: (tool: string) => Effect.Effect<void, Denied>
  readonly mcp: (server: string) => Effect.Effect<void, Denied>
  readonly localMcpCommand: (
    command: ChildProcess.Command,
    network: "none" | "full",
  ) => Effect.Effect<ChildProcess.Command, Denied>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Sandbox") {}

const SAFE_ENV = new Set(["COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TERM", "TZ"])

const layer = Layer.scoped(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const entries = yield* config.entries()
    const selections = entries.flatMap((entry) =>
      entry.type === "document" && entry.info.sandbox !== undefined ? [{ entry, value: entry.info.sandbox }] : [],
    )
    const enabled = selections.some(
      (item) => item.value === true || (item.value !== false && item.value.enabled !== false),
    )
    const trusted = selections.filter(
      (item) => item.entry.type === "document" && (!item.entry.path || !contains(location.directory, item.entry.path)),
    )
    const objects = selections.flatMap((item) =>
      item.value !== true && item.value !== false && item.value.enabled !== false ? [item.value] : [],
    )
    const trustedObjects = trusted.flatMap((item) =>
      item.value !== true && item.value !== false && item.value.enabled !== false ? [item.value] : [],
    )
    const roots = (key: "read" | "write", values = trustedObjects) =>
      values
        .flatMap((value) => value.filesystem?.[key] ?? [])
        .map((value) => AbsolutePath.make(path.resolve(location.directory, value)))
    const deny = objects
      .flatMap((value) => value.filesystem?.deny ?? [])
      .map((value) => AbsolutePath.make(path.resolve(location.directory, value)))
    const fullNetwork = trustedObjects.some(
      (value) => value.network === true || (typeof value.network === "object" && value.network.tools === "full"),
    )
    const restrictedSelections = trustedObjects.flatMap((value) =>
      typeof value.network === "object" && typeof value.network.tools === "object" ? value.network.tools.allow : [],
    )
    const hasRestricted = trustedObjects.some(
      (value) => typeof value.network === "object" && typeof value.network.tools === "object",
    )
    const network = fullNetwork ? "full" : hasRestricted ? { allow: restrictedSelections } : "none"
    const environment = trustedObjects.some((value) => value.environment === "all") ? "all" : "safe"
    const provider = trustedObjects.some(
      (value) => typeof value.network === "object" && value.network.provider === "disabled",
    )
      ? "disabled"
      : "configured"
    const mcp = new Set(
      trustedObjects.flatMap((value) => (typeof value.network === "object" ? (value.network.mcp?.allow ?? []) : [])),
    )
    const policy: Policy = {
      enabled,
      workspace: AbsolutePath.make(path.resolve(location.directory)),
      read: roots("read"),
      write: roots("write"),
      deny,
      network,
      provider,
      mcp,
      environment,
    }
    const broker =
      policy.enabled && typeof policy.network === "object"
        ? yield* SandboxNetwork.makeBroker(policy.network)
        : undefined
    if (policy.enabled && (process.platform !== "linux" || location.workspaceID))
      return yield* new Denied({
        operation: "execute",
        path: location.directory,
        reason: "sandbox is supported only for local Linux Locations",
      })
    const readRoots = yield* Effect.forEach(policy.enabled ? policy.read : [], (root) =>
      canonicalize(root, false).pipe(Effect.map((canonical) => ({ lexical: root, canonical }))),
    )
    const writeRoots = yield* Effect.forEach(policy.enabled ? [policy.workspace, ...policy.write] : [], (root) =>
      canonicalize(root, true).pipe(Effect.map((canonical) => ({ lexical: root, canonical }))),
    )
    const denyRoots = yield* Effect.forEach(policy.enabled ? policy.deny : [], (root) =>
      canonicalize(root, true).pipe(Effect.map((canonical) => ({ lexical: root, canonical }))),
    )

    const assertSupported = (operation: "read" | "write" | "execute" | "network", target: string) => {
      if (!policy.enabled) return Effect.void
      if (process.platform !== "linux" || location.workspaceID)
        return Effect.fail(
          new Denied({ operation, path: target, reason: "sandbox is supported only for local Linux Locations" }),
        )
      return Effect.void
    }

    // realpath closes lexical and symlink aliases at check time. This is document-access policy,
    // not kernel isolation: cooperating checks still retain normal TOCTOU, hardlink, and mount races.
    const authorize = Effect.fn("Sandbox.authorize")(function* (operation: "read" | "write", target: string) {
      yield* assertSupported(operation, target)
      if (!policy.enabled) return
      const lexical = path.resolve(target)
      const canonical = yield* canonicalize(lexical, operation === "write")
      if (denyRoots.some((root) => contains(root.lexical, lexical) || contains(root.canonical, canonical)))
        return yield* new Denied({ operation, path: target, reason: "path is denied by sandbox policy" })
      const allowed = [...writeRoots, ...(operation === "read" ? readRoots : [])]
      if (!allowed.some((root) => contains(root.lexical, lexical) && contains(root.canonical, canonical)))
        return yield* new Denied({ operation, path: target, reason: "path is outside sandbox roots" })
    })

    const isolate = Effect.fn("Sandbox.command")(function* (
      command: ChildProcess.Command,
      commandNetwork: "none" | "full" | SandboxNetwork.Policy,
      explicitEnvironment: boolean,
    ) {
      if (!policy.enabled) return command
      yield* assertSupported("execute", command._tag)
      if (command._tag !== "StandardCommand")
        return yield* new Denied({ operation: "execute", path: "pipeline", reason: "piped commands are unsupported" })
      const cwd = path.resolve(command.options.cwd ?? location.directory)
      yield* authorize("read", cwd)
      yield* authorize("write", cwd)
      const denied = yield* Effect.forEach(policy.deny, (target) =>
        Effect.tryPromise({
          try: () => fs.lstat(target),
          catch: () => new Denied({ operation: "execute", path: target, reason: "cannot mount denied path" }),
        }).pipe(Effect.map((info) => ({ target, directory: info.isDirectory() }))),
      )
      const env =
        policy.environment === "all" && !explicitEnvironment
          ? { ...process.env, ...command.options.env }
          : Object.fromEntries(
              Object.entries({ ...process.env, ...command.options.env }).filter(
                ([key, value]) =>
                  value !== undefined &&
                  (SAFE_ENV.has(key.toUpperCase()) || (explicitEnvironment && key in (command.options.env ?? {}))),
              ),
            )
      if (policy.environment === "safe" || explicitEnvironment) {
        env.OPENCODE_TERMINAL = "1"
        if (command.options.env?.BUN_BE_BUN === "1") env.BUN_BE_BUN = "1"
      }
      const runtime = ["/usr", "/bin", "/sbin", "/lib", "/lib64"]
      const etc = [
        "/etc/ld.so.cache",
        "/etc/nsswitch.conf",
        "/etc/hosts",
        "/etc/ssl",
        ...(commandNetwork === "full" ? ["/etc/resolv.conf"] : []),
      ]
      const restricted = typeof commandNetwork === "object"
      if (restricted && !broker)
        return yield* new Denied({ operation: "network", path: command.command, reason: "network broker unavailable" })
      const proxy = "http://127.0.0.1:18080"
      if (restricted) {
        Object.keys(env)
          .filter((key) => key.toUpperCase().endsWith("_PROXY"))
          .forEach((key) => delete env[key])
        env.HTTP_PROXY = proxy
        env.HTTPS_PROXY = proxy
        env.http_proxy = proxy
        env.https_proxy = proxy
        env.NO_PROXY = ""
        env.no_proxy = ""
        env.OPENCODE_BROKER_SOCKET = "/run/opencode-network/broker.sock"
      }
      const executable = path.isAbsolute(command.command) ? ["--ro-bind", command.command, command.command] : []
      const args = [
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        ...(commandNetwork === "full" ? ["--share-net"] : []),
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        ...(restricted ? ["--ro-bind", broker!.root, "/run/opencode-network"] : []),
        ...runtime.flatMap((root) => ["--ro-bind-try", root, root]),
        "--dir",
        "/etc",
        ...etc.flatMap((target) => ["--ro-bind-try", target, target]),
        ...executable,
        ...[...policy.read].flatMap((root) => ["--ro-bind", root, root]),
        ...[policy.workspace, ...policy.write].flatMap((root) => ["--bind", root, root]),
        ...denied.flatMap((item) =>
          item.directory ? ["--tmpfs", item.target] : ["--ro-bind", "/dev/null", item.target],
        ),
        "--chdir",
        cwd,
        "--",
        ...(restricted
          ? ["/usr/bin/python3", "/run/opencode-network/relay.py", command.command, ...command.args]
          : [command.command, ...command.args]),
      ]
      return ChildProcess.make("bwrap", args, {
        ...command.options,
        cwd: undefined,
        env,
        extendEnv: false,
      })
    })

    const command = (value: ChildProcess.Command) => isolate(value, policy.network, false)

    return Service.of({
      policy,
      read: (target) => authorize("read", target),
      write: (target) => authorize("write", target),
      command,
      localMcpCommand: (value, localNetwork) => isolate(value, localNetwork, true),
      mcp: (server) =>
        !policy.enabled || policy.mcp.has(server)
          ? Effect.void
          : Effect.fail(
              new Denied({ operation: "network", path: server, reason: "MCP server is not allowed by sandbox policy" }),
            ),
      network: (tool) =>
        assertSupported("network", tool).pipe(
          Effect.andThen(
            policy.enabled && policy.network !== "full"
              ? Effect.fail(
                  new Denied({
                    operation: "network",
                    path: tool,
                    reason:
                      policy.network === "none"
                        ? "tool network is disabled"
                        : "in-process network tools are unsupported in restricted mode",
                  }),
                )
              : Effect.void,
          ),
        ),
    })
  }),
)

const contains = (root: string, target: string) => {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const canonicalize = (target: string, create: boolean) =>
  Effect.tryPromise({
    try: async () => {
      if (!create) return fs.realpath(target)
      const suffix: string[] = []
      for (let current = target; ; current = path.dirname(current)) {
        const resolved = await fs.realpath(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
          throw error
        })
        if (resolved) return path.join(resolved, ...suffix.toReversed())
        const parent = path.dirname(current)
        if (parent === current) throw new Error(`No existing parent for ${target}`)
        suffix.push(path.basename(current))
      }
    },
    catch: () => new Denied({ operation: create ? "write" : "read", path: target, reason: "cannot resolve path" }),
  })

export const node = makeLocationNode({
  service: Service,
  layer: Layer.orDie(layer),
  deps: [Config.node, Location.node],
})
