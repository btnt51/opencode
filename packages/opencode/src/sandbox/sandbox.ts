export * as Sandbox from "./sandbox"

import { ChildProcess } from "effect/unstable/process"
import fs from "fs/promises"
import path from "path"

type Config =
  | boolean
  | {
      enabled?: boolean
      filesystem?: { read?: string[]; write?: string[]; deny?: string[] }
      network?: boolean
      environment?: "safe" | "all"
    }

const SAFE_ENV = new Set(["COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "TERM", "TZ"])
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

export async function command(input: {
  config?: Config
  shell: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
}) {
  if (!enabled(input.config)) {
    return ChildProcess.make(input.command, [], {
      shell: input.shell,
      cwd: input.cwd,
      env: input.env,
      stdin: "ignore",
      detached: process.platform !== "win32",
    })
  }
  if (process.platform !== "linux") throw new UnavailableError(`Linux is required (running on ${process.platform})`)
  const executable = Bun.which("bwrap")
  if (!executable) throw new UnavailableError("bubblewrap (bwrap) was not found in PATH")

  const config = typeof input.config === "object" ? input.config : {}
  const cwd = await fs.realpath(input.cwd).catch(() => {
    throw new UnavailableError(`working directory does not exist: ${input.cwd}`)
  })
  const writable = await paths([cwd, ...(config.filesystem?.write ?? [])])
  const readable = await paths(config.filesystem?.read ?? [])
  const denied = await paths(config.filesystem?.deny ?? [], false)
  const overlaps = [...writable, ...readable].find((item) => denied.some((deny) => within(item, deny)))
  if (overlaps) throw new UnavailableError(`allowed path is contained by denied path: ${overlaps}`)

  const args = ["--die-with-parent", "--new-session", "--unshare-all"]
  if (config.network === true) args.push("--share-net")
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
  for (const item of readable) args.push("--ro-bind", item, item)
  for (const item of writable) args.push("--bind", item, item)
  for (const item of denied) {
    const directory = await fs.stat(item).then(
      (stat) => stat.isDirectory(),
      () => false,
    )
    args.push(directory ? "--tmpfs" : "--ro-bind", directory ? item : "/dev/null", ...(directory ? [] : [item]))
  }
  args.push("--chdir", cwd, "--", input.shell, "-c", input.command)

  return ChildProcess.make(executable, args, {
    env: config.environment === "all" ? input.env : safeEnvironment(input.env),
    stdin: "ignore",
    detached: true,
  })
}

export function enabled(config?: Config) {
  return config === true || (typeof config === "object" && config.enabled !== false)
}

export function safeEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => SAFE_ENV.has(key) && value !== undefined))
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

function within(item: string, parent: string) {
  const relative = path.relative(parent, item)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
