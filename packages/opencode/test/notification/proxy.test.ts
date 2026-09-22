import { describe, expect, test } from "bun:test"
import { ProxyEnv } from "@/util/proxy-env"
import { TrustedHttp } from "@/util/trusted-http"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { createServer } from "node:http"

const destination = "https://api.telegram.org"

describe("trusted notification proxy", () => {
  test("defaults to direct and honors explicit direct mode", () => {
    expect(TrustedHttp.resolveProxy({ destination })).toBeUndefined()
    expect(
      TrustedHttp.resolveProxy({
        destination,
        proxy: { mode: "direct" },
        environment: { HTTPS_PROXY: "http://127.0.0.1:7890" },
      }),
    ).toBeUndefined()
  })

  test("selects HTTPS_PROXY and lowercase takes precedence", () => {
    expect(
      TrustedHttp.resolveProxy({
        destination,
        proxy: { mode: "environment" },
        environment: {
          HTTPS_PROXY: "http://uppercase:7890",
          https_proxy: "http://lowercase:7890",
          ALL_PROXY: "http://fallback:7890",
        },
      })?.hostname,
    ).toBe("lowercase")
  })

  test("uses ALL_PROXY only when the HTTPS proxy is absent", () => {
    expect(
      TrustedHttp.resolveProxy({
        destination,
        proxy: { mode: "environment" },
        environment: { ALL_PROXY: "http://127.0.0.1:7890" },
      })?.href,
    ).toBe("http://127.0.0.1:7890/")
    expect(TrustedHttp.resolveProxy({ destination, proxy: { mode: "environment" }, environment: {} })).toBeUndefined()
  })

  test("NO_PROXY bypasses exact hosts and localhost without bypassing non-matches", () => {
    const environment = { HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "api.telegram.org,localhost" }
    expect(TrustedHttp.resolveProxy({ destination, proxy: { mode: "environment" }, environment })).toBeUndefined()
    expect(ProxyEnv.getProxyForUrl("https://localhost", environment)).toBeUndefined()
    expect(ProxyEnv.getProxyForUrl("https://example.com", environment)).toBe("http://127.0.0.1:7890")
  })

  test("explicit URLs support authentication without exposing it through validation errors", () => {
    expect(
      TrustedHttp.resolveProxy({
        destination,
        proxy: { mode: "url", url: "http://user:password@127.0.0.1:7890" },
      })?.password,
    ).toBe("password")
    for (const url of ["secret-password", "socks5://user:secret-password@127.0.0.1:1080"]) {
      expect(() => TrustedHttp.resolveProxy({ destination, proxy: { mode: "url", url } })).toThrow()
      try {
        TrustedHttp.resolveProxy({ destination, proxy: { mode: "url", url } })
      } catch (error) {
        expect(String(error)).not.toContain("secret-password")
        expect(String(error)).not.toContain("user:")
      }
    }
  })

  test("uses CONNECT to Telegram and fails without a direct fallback", async () => {
    const connects: string[] = []
    const proxy = createServer()
    proxy.on("connect", (request, socket) => {
      connects.push(request.url ?? "")
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
    })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    const proxyAddress = proxy.address()
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Expected proxy TCP address")

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const base = yield* HttpClient.HttpClient
        const transport = yield* TrustedHttp.client({
          direct: base,
          destination,
          proxy: { mode: "url", url: `http://127.0.0.1:${proxyAddress.port}` },
        })
        yield* transport.client.execute(HttpClientRequest.get("https://api.telegram.org/telegram-test"))
      }).pipe(Effect.timeout("2 seconds"), Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    )
    await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())))

    expect(result._tag).toBe("Failure")
    expect(connects).toEqual(["api.telegram.org:443"])
  })
})
