export * as Sandbox from "./sandbox"

import { ChildProcess } from "effect/unstable/process"
import fs from "fs/promises"
import path from "path"

export type Config =
  | boolean
  | {
      enabled?: boolean
      filesystem?: { read?: string[]; write?: string[]; deny?: string[] }
      network?:
        | boolean
        | {
            tools?: "none" | "full"
            provider?: "configured" | "disabled"
            mcp?: { allow: string[] }
          }
      environment?: "safe" | "all"
    }

const SAFE_ENV = new Set(["COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TERM", "TZ"])
const TRUSTED_ENV = new Set([
  "OPENCODE_TELEGRAM_BOT_TOKEN",
  "OPENCODE_TELEGRAM_CHAT_ID",
  "OPENCODE_TELEGRAM_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
])
const SYSTEM_PATHS = ["/bin", "/usr", "/lib", "/lib64"]
const RUNTIME_PATHS = [
  "/etc/ca-certificates",
  "/etc/group",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/pki",
  "/etc/resolv.conf",
  "/etc/ssl",
]

export class UnavailableError extends Error {
  constructor(message: string) {
    super(`Sandbox requested but cannot be enforced: ${message}`)
    this.name = "SandboxUnavailableError"
  }
}

export class FilesystemDeniedError extends Error {
  readonly operation: "read" | "write"
  readonly requestedPath: string
  readonly effectivePath: string

  constructor(operation: "read" | "write", requestedPath: string, effectivePath: string) {
    super(
      `Sandbox denied ${operation} access to:\n${requestedPath}\nThe path is outside the configured sandbox filesystem roots.`,
    )
    this.name = "SandboxFilesystemDeniedError"
    this.operation = operation
    this.requestedPath = requestedPath
    this.effectivePath = effectivePath
  }
}

export type FilesystemPolicy = Awaited<ReturnType<typeof resolveFilesystemPolicy>>

export async function resolveFilesystemPolicy(config: Config | undefined, cwd: string) {
  const active = enabled(config)
  const structured = typeof config === "object" ? config : {}
  const workspace = await canonical(cwd, true)
  const writableRoots = active ? await paths([workspace, ...(structured.filesystem?.write ?? [])]) : []
  const readableRoots = active ? await paths(structured.filesystem?.read ?? []) : []
  const deniedRoots = active ? await paths(structured.filesystem?.deny ?? [], false) : []
  const roots = Array.from(new Set([...writableRoots, ...readableRoots]))

  const inspect = async (operation: "read" | "write", requestedPath: string) => {
    if (!active) return { allowed: true, path: path.resolve(requestedPath) }
    const effectivePath = await canonical(requestedPath, false)
    const denied = deniedRoots.some((root) => within(effectivePath, root))
    const allowedRoots = operation === "write" ? writableRoots : roots
    return { allowed: !denied && allowedRoots.some((root) => within(effectivePath, root)), path: effectivePath }
  }

  const assert = async (operation: "read" | "write", requestedPath: string) => {
    const result = await inspect(operation, requestedPath)
    if (!result.allowed) throw new FilesystemDeniedError(operation, requestedPath, result.path)
    return result.path
  }

  const assertReadTree = async (requestedPath: string) => {
    const effectivePath = await assert("read", requestedPath)
    if (active && deniedRoots.some((root) => within(root, effectivePath))) {
      throw new FilesystemDeniedError("read", requestedPath, effectivePath)
    }
    return effectivePath
  }

  return {
    enabled: active,
    cwd: workspace,
    readableRoots: roots,
    writableRoots,
    deniedRoots,
    canRead: async (requestedPath: string) => (await inspect("read", requestedPath)).allowed,
    canWrite: async (requestedPath: string) => (await inspect("write", requestedPath)).allowed,
    assertRead: (requestedPath: string) => assert("read", requestedPath),
    assertReadTree,
    assertWrite: (requestedPath: string) => assert("write", requestedPath),
  }
}

export async function command(input: {
  config?: Config
  shell: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
}) {
  const env = untrustedEnvironment(input.env)
  if (!enabled(input.config)) {
    return ChildProcess.make(input.command, [], {
      shell: input.shell,
      cwd: input.cwd,
      env,
      stdin: "ignore",
      detached: process.platform !== "win32",
    })
  }
  if (process.platform !== "linux") throw new UnavailableError(`Linux is required (running on ${process.platform})`)
  const executable = Bun.which("bwrap")
  if (!executable) throw new UnavailableError("bubblewrap (bwrap) was not found in PATH")

  const config = typeof input.config === "object" ? input.config : {}
  const policy = await resolveFilesystemPolicy(input.config, input.cwd)
  const cwd = policy.cwd

  const args = ["--die-with-parent", "--new-session", "--unshare-all"]
  if (toolNetwork(input.config) === "full") args.push("--share-net")
  args.push("--dev", "/dev", "--tmpfs", "/tmp")
  for (const item of SYSTEM_PATHS) {
    if (
      await fs.stat(item).then(
        () => true,
        () => false,
      )
    )
      args.push("--ro-bind", item, item)
  }
  for (const item of RUNTIME_PATHS) {
    if (
      await fs.stat(item).then(
        () => true,
        () => false,
      )
    )
      args.push("--ro-bind", item, item)
  }
  for (const item of policy.readableRoots.filter((item) => !policy.writableRoots.includes(item)))
    args.push("--ro-bind", item, item)
  for (const item of policy.writableRoots) args.push("--bind", item, item)
  for (const item of policy.deniedRoots) {
    const directory = await fs.stat(item).then(
      (stat) => stat.isDirectory(),
      () => false,
    )
    args.push(directory ? "--tmpfs" : "--ro-bind", directory ? item : "/dev/null", ...(directory ? [] : [item]))
  }
  args.push("--chdir", cwd, "--", input.shell, "-c", input.command)

  return ChildProcess.make(executable, args, {
    env: config.environment === "all" ? env : safeEnvironment(env),
    stdin: "ignore",
    detached: true,
  })
}

export async function localMcp(input: {
  config?: Config
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  configuredEnvironment?: Record<string, string>
  network?: "none" | "full"
}) {
  const env = untrustedEnvironment(input.env)
  if (!enabled(input.config)) {
    return {
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: { ...env, ...input.configuredEnvironment },
    }
  }
  if (process.platform !== "linux") throw new UnavailableError(`Linux is required (running on ${process.platform})`)
  const executable = Bun.which("bwrap")
  if (!executable) throw new UnavailableError("bubblewrap (bwrap) was not found in PATH")
  const config = typeof input.config === "object" ? input.config : {}
  const policy = await resolveFilesystemPolicy(input.config, input.cwd)
  const cwd = policy.cwd
  const args = ["--die-with-parent", "--new-session", "--unshare-all"]
  if (input.network === "full") args.push("--share-net")
  args.push("--dev", "/dev", "--tmpfs", "/tmp")
  for (const item of [...SYSTEM_PATHS, ...RUNTIME_PATHS]) {
    if (
      await fs.stat(item).then(
        () => true,
        () => false,
      )
    )
      args.push("--ro-bind", item, item)
  }
  for (const item of policy.readableRoots.filter((item) => !policy.writableRoots.includes(item)))
    args.push("--ro-bind", item, item)
  for (const item of policy.writableRoots) args.push("--bind", item, item)
  for (const item of policy.deniedRoots) {
    const directory = await fs.stat(item).then(
      (stat) => stat.isDirectory(),
      () => false,
    )
    args.push(directory ? "--tmpfs" : "--ro-bind", directory ? item : "/dev/null", ...(directory ? [] : [item]))
  }
  args.push("--chdir", cwd, "--", input.command, ...input.args)
  return {
    command: executable,
    args,
    cwd: undefined,
    env: { ...safeEnvironment(env), ...input.configuredEnvironment },
  }
}

export function toolNetwork(config?: Config) {
  if (typeof config !== "object") return config === true ? ("none" as const) : ("full" as const)
  if (typeof config.network === "boolean") return config.network ? ("full" as const) : ("none" as const)
  return config.network?.tools ?? "none"
}

export function providerNetwork(config?: Config) {
  if (typeof config !== "object" || typeof config.network !== "object") return "configured" as const
  return config.network.provider ?? "configured"
}

export function mcpAllowed(config: Config | undefined, name: string) {
  if (typeof config !== "object" || typeof config.network !== "object") return true
  return config.network.mcp?.allow.includes(name) ?? false
}

export function mcpAllowlist(config?: Config) {
  if (typeof config !== "object" || typeof config.network !== "object") return undefined
  return config.network.mcp?.allow ?? []
}

export function unknownMcp(config: Config | undefined, names: string[]) {
  return mcpAllowlist(config)?.filter((name) => !names.includes(name)) ?? []
}

export function enabled(config?: Config) {
  return config === true || (typeof config === "object" && config.enabled !== false)
}

export function safeEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => SAFE_ENV.has(key) && value !== undefined))
}

export function untrustedEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !TRUSTED_ENV.has(key.toUpperCase())))
}

async function paths(items: string[], required = true) {
  return Promise.all(
    items.map(async (item) => {
      if (!path.isAbsolute(item)) throw new UnavailableError(`sandbox paths must be absolute: ${item}`)
      return fs.realpath(item).catch(() => {
        if (required) throw new UnavailableError(`sandbox path does not exist: ${item}`)
        return path.resolve(item)
      })
    }),
  ).then((result) => Array.from(new Set(result)))
}

// For a missing write target, realpath the closest existing ancestor and append
// the missing suffix. This catches existing symlinked parents without pretending
// to eliminate the check/use race inherent in path-based filesystem APIs.
async function canonical(item: string, required: boolean): Promise<string> {
  const absolute = path.resolve(item)
  const resolved = await fs.realpath(absolute).catch(() => undefined)
  if (resolved) return resolved
  if (required) throw new UnavailableError(`sandbox path does not exist: ${item}`)
  const parent = path.dirname(absolute)
  if (parent === absolute) return absolute
  return path.join(await canonical(parent, false), path.basename(absolute))
}

function within(item: string, parent: string) {
  const relative = path.relative(parent, item)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
