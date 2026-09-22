import path from "path"
import { Effect, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { Sandbox } from "@/sandbox/sandbox"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
  operation?: "read" | "write"
  recursive?: boolean
  sandboxOnly?: boolean
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false

  const config = yield* Effect.serviceOption(Config.Service)
  const ins = yield* InstanceState.context
  const cfg = Option.isSome(config) ? yield* config.value.get() : undefined
  const policy = yield* Effect.promise(() => Sandbox.resolveFilesystemPolicy(cfg?.sandbox, ins.directory))
  yield* Effect.promise(() =>
    options?.operation === "write"
      ? policy.assertWrite(target)
      : options?.recursive
        ? policy.assertReadTree(target)
        : policy.assertRead(target),
  )

  if (options?.sandboxOnly) return false

  if (options?.bypass) return false

  const full = process.platform === "win32" ? FSUtil.normalizePath(target) : target
  if (containsPath(full, ins)) return false

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
  return true
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}
