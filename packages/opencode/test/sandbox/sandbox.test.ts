import { describe, expect, test } from "bun:test"
import { Sandbox } from "@/sandbox/sandbox"

describe("sandbox", () => {
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
