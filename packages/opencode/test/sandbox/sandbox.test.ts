import { describe, expect, test } from "bun:test"
import { Sandbox } from "@/sandbox/sandbox"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

describe("sandbox", () => {
  test("filesystem policy is fail-closed, canonical, and preserves the writable workspace", async () => {
    await using root = await tmpdir()
    const workspace = path.join(root.path, "project")
    const readonly = path.join(root.path, "shared")
    const outside = path.join(root.path, "outside")
    const denied = path.join(workspace, "secrets")
    await Promise.all([workspace, readonly, outside, denied].map((item) => fs.mkdir(item, { recursive: true })))
    await Promise.all([
      fs.writeFile(path.join(workspace, "inside.txt"), "inside"),
      fs.writeFile(path.join(readonly, "shared.txt"), "shared"),
      fs.writeFile(path.join(outside, "secret.txt"), "secret"),
      fs.writeFile(path.join(denied, "key.txt"), "key"),
    ])

    const policy = await Sandbox.resolveFilesystemPolicy(
      { enabled: true, filesystem: { read: [readonly], deny: [denied] } },
      workspace,
    )

    expect(await policy.canRead(path.join(workspace, "inside.txt"))).toBe(true)
    expect(await policy.canWrite(path.join(workspace, "new.txt"))).toBe(true)
    expect(await policy.canRead(path.join(readonly, "shared.txt"))).toBe(true)
    expect(await policy.canWrite(path.join(readonly, "shared.txt"))).toBe(false)
    expect(await policy.canRead(path.join(outside, "secret.txt"))).toBe(false)
    expect(await policy.canRead(path.join(workspace, "..", "outside", "secret.txt"))).toBe(false)
    expect(await policy.canRead(path.join(denied, "key.txt"))).toBe(false)
    await expect(policy.assertReadTree(workspace)).rejects.toBeInstanceOf(Sandbox.FilesystemDeniedError)
  })

  test("filesystem policy rejects file and directory symlink escapes for reads and new writes", async () => {
    if (process.platform === "win32") return
    await using root = await tmpdir()
    const workspace = path.join(root.path, "project")
    const outside = path.join(root.path, "outside")
    await Promise.all([workspace, outside].map((item) => fs.mkdir(item, { recursive: true })))
    await fs.writeFile(path.join(outside, "secret.txt"), "secret")
    await fs.symlink(path.join(outside, "secret.txt"), path.join(workspace, "escape-file"))
    await fs.symlink(outside, path.join(workspace, "escape-dir"))
    const policy = await Sandbox.resolveFilesystemPolicy(true, workspace)

    await expect(policy.assertRead(path.join(workspace, "escape-file"))).rejects.toBeInstanceOf(
      Sandbox.FilesystemDeniedError,
    )
    await expect(policy.assertRead(path.join(workspace, "escape-dir", "secret.txt"))).rejects.toBeInstanceOf(
      Sandbox.FilesystemDeniedError,
    )
    await expect(policy.assertWrite(path.join(workspace, "escape-dir", "new.txt"))).rejects.toBeInstanceOf(
      Sandbox.FilesystemDeniedError,
    )
  })

  test("disabled filesystem policy preserves unrestricted host path behavior", async () => {
    await using root = await tmpdir()
    const workspace = path.join(root.path, "project")
    const outside = path.join(root.path, "outside.txt")
    await fs.mkdir(workspace)
    const policy = await Sandbox.resolveFilesystemPolicy(false, workspace)
    expect(await policy.canRead(outside)).toBe(true)
    expect(await policy.canWrite(outside)).toBe(true)
  })

  test("disabled preserves the regular command", async () => {
    const command = await Sandbox.command({
      config: false,
      shell: "/bin/sh",
      command: "echo ok",
      cwd: process.cwd(),
      env: { SECRET_TOKEN: "secret" },
    })
    expect(command.command).toBe("echo ok")
    expect(command.options.shell).toBe("/bin/sh")
    expect(command.options.env).toEqual({ SECRET_TOKEN: "secret" })
  })

  test("safe environment excludes credentials", () => {
    expect(
      Sandbox.safeEnvironment({ PATH: "/bin", LANG: "C", AWS_SECRET_ACCESS_KEY: "secret", TOKEN: "secret" }),
    ).toEqual({
      PATH: "/bin",
      LANG: "C",
    })
  })

  test("notification credentials never enter commands or local MCP unless explicitly configured", async () => {
    const env = {
      PATH: "/bin",
      OPENCODE_TELEGRAM_BOT_TOKEN: "bot-secret",
      OPENCODE_TELEGRAM_CHAT_ID: "chat-secret",
      OPENCODE_TELEGRAM_PROXY: "http://user:password@127.0.0.1:7890",
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost",
    }
    const command = await Sandbox.command({
      config: false,
      shell: "/bin/sh",
      command: "true",
      cwd: process.cwd(),
      env,
    })
    expect(command.options.env).toEqual({ PATH: "/bin" })
    expect(Sandbox.toolNetwork({ network: { tools: "none" } })).toBe("none")
    const mcp = await Sandbox.localMcp({
      config: false,
      command: "server",
      args: [],
      cwd: process.cwd(),
      env,
      configuredEnvironment: { OPENCODE_TELEGRAM_CHAT_ID: "explicit" },
    })
    expect(mcp.env).toEqual({ PATH: "/bin", OPENCODE_TELEGRAM_CHAT_ID: "explicit" })
  })

  test("legacy and structured network policies remain distinct", () => {
    expect(Sandbox.toolNetwork({ network: false })).toBe("none")
    expect(Sandbox.toolNetwork({ network: true })).toBe("full")
    expect(
      Sandbox.toolNetwork({ network: { tools: "none", provider: "configured", mcp: { allow: ["company"] } } }),
    ).toBe("none")
    expect(Sandbox.providerNetwork({ network: { provider: "disabled" } })).toBe("disabled")
    expect(Sandbox.mcpAllowed({ network: { mcp: { allow: ["company"] } } }, "company")).toBe(true)
    expect(Sandbox.mcpAllowed({ network: { mcp: { allow: ["company"] } } }, "other")).toBe(false)
    expect(Sandbox.mcpAllowed({ network: false }, "legacy")).toBe(true)
    expect(
      Sandbox.unknownMcp({ network: { mcp: { allow: ["company", "missing"] } } }, ["company", "disabled"]),
    ).toEqual(["missing"])
  })

  test("local MCP sandbox is networkless and filters inherited credentials", async () => {
    if (process.platform !== "linux" || !Bun.which("bwrap")) return
    const command = await Sandbox.localMcp({
      config: { enabled: true, network: { tools: "none" } },
      command: "/bin/sh",
      args: ["-c", "true"],
      cwd: process.cwd(),
      env: { PATH: "/bin", OPENAI_API_KEY: "secret", HTTPS_PROXY: "secret", SSH_AUTH_SOCK: "/run/agent" },
      configuredEnvironment: { MCP_TOKEN: "configured" },
    })
    expect(command.args).toContain("--unshare-all")
    expect(command.args).not.toContain("--share-net")
    expect(command.env).toEqual({ PATH: "/bin", MCP_TOKEN: "configured" })
    expect(command.args).not.toContain("/run")
    expect(command.args).not.toContain("/var/run")
  })

  test("local MCP full network is explicit", async () => {
    if (process.platform !== "linux" || !Bun.which("bwrap")) return
    const command = await Sandbox.localMcp({
      config: true,
      command: "/bin/sh",
      args: ["-c", "true"],
      cwd: process.cwd(),
      env: {},
      network: "full",
    })
    expect(command.args).toContain("--share-net")
  })

  test("network isolation applies to shell children and arbitrary executables", async () => {
    if (process.platform !== "linux" || !Bun.which("bwrap")) return
    const command = await Sandbox.command({
      config: { network: { tools: "none" } },
      shell: "/bin/sh",
      command: '/bin/sh -c \'python3 -c "import socket; socket.create_connection((\\"1.1.1.1\\", 53), 1)"\'',
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
    })
    const processHandle = Bun.spawn([command.command, ...command.args], {
      cwd: command.options.cwd,
      env: command.options.env,
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await processHandle.exited).not.toBe(0)
    processHandle.unref()
  })

  test("manual regression: shell cannot read a sibling outside the workspace", async () => {
    if (process.platform !== "linux" || !Bun.which("bwrap")) return
    await using root = await tmpdir()
    const workspace = path.join(root.path, "project")
    const outside = path.join(root.path, "outside")
    await Promise.all([workspace, outside].map((item) => fs.mkdir(item)))
    await fs.writeFile(path.join(workspace, "inside.txt"), "inside")
    await fs.writeFile(path.join(outside, "secret.txt"), "secret")
    const command = await Sandbox.command({
      config: { enabled: true },
      shell: "/bin/sh",
      command: "cat ../outside/secret.txt",
      cwd: workspace,
      env: { PATH: process.env.PATH },
    })
    const handle = Bun.spawn([command.command, ...command.args], {
      cwd: command.options.cwd,
      env: command.options.env,
      stdout: "ignore",
      stderr: "ignore",
    })
    expect(await handle.exited).not.toBe(0)
  })

  test("sandbox exposes essential host runtime files read-only", async () => {
    if (process.platform !== "linux" || !Bun.which("bwrap")) return
    const command = await Sandbox.command({
      config: true,
      shell: "/bin/sh",
      command: "true",
      cwd: process.cwd(),
      env: {},
    })
    const args = command.args
    const bind = (file: string) => args.some((item, index) => item === "--ro-bind" && args[index + 1] === file)

    expect(bind("/etc/passwd")).toBe(true)
    expect(bind("/etc/resolv.conf")).toBe(true)
  })

  test("requested sandbox fails closed when unavailable", async () => {
    if (process.platform === "linux" && Bun.which("bwrap")) return
    expect(
      Sandbox.command({ config: true, shell: "/bin/sh", command: "true", cwd: process.cwd(), env: {} }),
    ).rejects.toBeInstanceOf(Sandbox.UnavailableError)
  })
})
