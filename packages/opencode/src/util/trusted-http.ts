export * as TrustedHttp from "./trusted-http"

import { NodeHttpClient } from "@effect/platform-node"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ProxyAgent } from "undici-real"
import { ProxyEnv } from "./proxy-env"

export type Proxy = { mode: "direct" } | { mode: "environment" } | { mode: "url"; url: string }

export function resolveProxy(input: { proxy?: Proxy; destination: string | URL; environment?: NodeJS.ProcessEnv }) {
  if (!input.proxy || input.proxy.mode === "direct") return
  const value =
    input.proxy.mode === "url"
      ? input.proxy.url
      : ProxyEnv.getProxyForUrl(input.destination, input.environment ?? process.env)
  if (!value) return
  return requireProxyUrl(value)
}

export const client = Effect.fn("TrustedHttp.client")(function* (input: {
  direct: HttpClient.HttpClient
  proxy?: Proxy
  destination: string | URL
  environment?: NodeJS.ProcessEnv
}) {
  const proxy = resolveProxy(input)
  if (!proxy) return { client: input.direct, proxied: false }
  const dispatcher = yield* Effect.acquireRelease(
    Effect.sync(() => new ProxyAgent({ uri: proxy.toString(), proxyTunnel: true })),
    (agent) => Effect.promise(() => agent.destroy()),
  )
  const http = yield* NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, dispatcher))
  return { client: http, proxied: true }
})

function requireProxyUrl(input: string) {
  if (!URL.canParse(input)) throw new Error("Invalid trusted HTTP proxy URL")
  const url = new URL(input)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported trusted HTTP proxy protocol: ${url.protocol.replace(":", "")}`)
  }
  if (!url.hostname) throw new Error("Trusted HTTP proxy URL requires a hostname")
  return url
}
