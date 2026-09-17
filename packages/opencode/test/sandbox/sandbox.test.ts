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
