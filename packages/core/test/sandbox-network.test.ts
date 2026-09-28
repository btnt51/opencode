import { describe, expect, test } from "bun:test"
import dns from "node:dns/promises"
import net from "node:net"
import { Effect } from "effect"
import { SandboxNetwork } from "@opencode/core/sandbox/network"

describe("restricted network endpoint policy", () => {
  const policy = {
    allow: [
      { host: "github.com.", ports: [443] },
      { host: "bücher.example", ports: [443], includeSubdomains: true },
      { host: "git.corp.example", ports: [443], private: true },
      { host: "192.168.20.2", ports: [8443], private: true },
    ],
  }

  test("normalizes IDN and trailing dots and uses DNS label boundaries", () => {
    expect(SandboxNetwork.ruleFor(policy, "GITHUB.COM", 443)).toBeDefined()
    expect(SandboxNetwork.ruleFor(policy, "xn--bcher-kva.example.", 443)).toBeDefined()
    expect(SandboxNetwork.ruleFor(policy, "api.xn--bcher-kva.example", 443)).toBeDefined()
    expect(SandboxNetwork.ruleFor(policy, "notgithub.com", 443)).toBeUndefined()
    expect(SandboxNetwork.ruleFor(policy, "github.com.evil", 443)).toBeUndefined()
    expect(SandboxNetwork.ruleFor(policy, "github.com", 80)).toBeUndefined()
  })

  test("keeps private, local, metadata, multicast, and unspecified capabilities distinct", () => {
    const corporate = SandboxNetwork.ruleFor(policy, "git.corp.example", 443)!
    expect(SandboxNetwork.authorizeAddress(corporate, "10.2.3.4")).toBe(true)
    expect(SandboxNetwork.authorizeAddress(corporate, "fd00::1")).toBe(true)
    expect(SandboxNetwork.authorizeAddress(corporate, "127.0.0.1")).toBe(false)
    expect(SandboxNetwork.authorizeAddress(corporate, "::ffff:127.0.0.1")).toBe(false)
    expect(SandboxNetwork.authorizeAddress(corporate, "169.254.169.254")).toBe(false)
    expect(SandboxNetwork.authorizeAddress(corporate, "fe80::1")).toBe(false)
    expect(SandboxNetwork.authorizeAddress(corporate, "0.0.0.0")).toBe(false)
    expect(SandboxNetwork.authorizeAddress(corporate, "ff02::1")).toBe(false)
  })

  test("requires private opt-in for direct private IP rules", () => {
    const direct = SandboxNetwork.ruleFor(policy, "192.168.20.2", 8443)!
    expect(SandboxNetwork.authorizeAddress(direct, "192.168.20.2")).toBe(true)
    expect(SandboxNetwork.authorizeAddress({ host: "192.168.20.2", ports: [8443] }, "192.168.20.2")).toBe(false)
  })
})

describe("restricted network broker", () => {
  test("authorizes before DNS and pins the selected address", async () => {
    let lookups = 0
    let connected = ""
    const upstream = net.createServer((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"))
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const port = (upstream.address() as net.AddressInfo).port
    const run = Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* SandboxNetwork.makeBroker(
          { allow: [{ host: "allowed.example", ports: [80] }] },
          {
            lookup: ((_host: string, _options: unknown) => {
              lookups++
              return Promise.resolve([{ address: "93.184.216.34", family: 4 }])
            }) as typeof dns.lookup,
            connect: (host) => {
              connected = host
              return new Promise((resolve, reject) =>
                net
                  .connect(port, "127.0.0.1")
                  .once("connect", function () {
                    resolve(this)
                  })
                  .once("error", reject),
              )
            },
          },
        )
        const request = (value: string) =>
          new Promise<string>((resolve) => {
            const chunks: Buffer[] = []
            net
              .connect(broker.socket)
              .once("connect", function () {
                this.write(value)
              })
              .on("data", (chunk) => chunks.push(chunk))
              .once("close", () => resolve(Buffer.concat(chunks).toString()))
          })
        expect(
          yield* Effect.promise(() =>
            request("CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n"),
          ),
        ).toBe("")
        expect(lookups).toBe(0)
        expect(
          yield* Effect.promise(() => request("GET http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n")),
        ).toContain("ok")
      }),
    )
    await Effect.runPromise(run)
    upstream.close()
    expect(lookups).toBe(1)
    expect(connected).toBe("93.184.216.34")
  })
})
