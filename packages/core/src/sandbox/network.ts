export * as SandboxNetwork from "./network.js"

import dns from "node:dns/promises"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { domainToASCII } from "node:url"
import { ConfigSandbox } from "@opencode/schema/config/sandbox"
import { Effect } from "effect"

export interface Policy {
  readonly allow: readonly ConfigSandbox.NetworkRule[]
}

export interface BrokerOptions {
  readonly lookup?: typeof dns.lookup
  readonly connect?: (host: string, port: number, family: number) => Promise<net.Socket>
}

const forbidden = new net.BlockList()
forbidden.addSubnet("0.0.0.0", 8, "ipv4")
forbidden.addSubnet("127.0.0.0", 8, "ipv4")
forbidden.addSubnet("169.254.0.0", 16, "ipv4")
forbidden.addSubnet("224.0.0.0", 4, "ipv4")
forbidden.addSubnet("::", 128, "ipv6")
forbidden.addSubnet("::1", 128, "ipv6")
forbidden.addSubnet("fe80::", 10, "ipv6")
forbidden.addSubnet("ff00::", 8, "ipv6")
const privateAddresses = new net.BlockList()
privateAddresses.addSubnet("10.0.0.0", 8, "ipv4")
privateAddresses.addSubnet("172.16.0.0", 12, "ipv4")
privateAddresses.addSubnet("192.168.0.0", 16, "ipv4")
privateAddresses.addSubnet("fc00::", 7, "ipv6")

export const normalizeHost = (value: string) => {
  const unwrapped = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value
  const host = unwrapped.endsWith(".") ? unwrapped.slice(0, -1) : unwrapped
  const normalized = net.isIP(host) ? host.toLowerCase() : domainToASCII(host).toLowerCase()
  if (!normalized || normalized.includes("\0")) throw new Error("invalid endpoint host")
  return normalized
}

export const ruleFor = (policy: Policy, hostname: string, port: number) => {
  const host = normalizeHost(hostname)
  return policy.allow.find((rule) => {
    const expected = normalizeHost(rule.host)
    return (
      rule.ports.includes(port) &&
      (host === expected || (rule.includeSubdomains === true && host.endsWith(`.${expected}`)))
    )
  })
}

export const authorizeAddress = (rule: ConfigSandbox.NetworkRule, address: string) => {
  const normalized = normalizeAddress(address)
  const family = net.isIP(normalized) === 6 ? "ipv6" : "ipv4"
  if (forbidden.check(normalized, family)) return false
  if (privateAddresses.check(normalized, family)) return rule.private === true
  return true
}

const normalizeAddress = (address: string) => {
  const lower = address.toLowerCase()
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice(7)
    if (net.isIPv4(mapped)) return mapped
  }
  return lower
}

const relay = `import asyncio, os, sys
SOCKET=os.environ["OPENCODE_BROKER_SOCKET"]
async def client(reader, writer):
  try:
    remote_reader, remote_writer = await asyncio.open_unix_connection(SOCKET)
    async def copy(source, target):
      while data := await source.read(65536):
        target.write(data); await target.drain()
      target.close()
    await asyncio.gather(copy(reader, remote_writer), copy(remote_reader, writer))
  except Exception:
    writer.close()
async def main():
  server = await asyncio.start_server(client, "127.0.0.1", 18080)
  process = await asyncio.create_subprocess_exec(*sys.argv[1:])
  async with server: code = await process.wait()
  raise SystemExit(code)
asyncio.run(main())
`

export const makeBroker = (policy: Policy, options: BrokerOptions = {}) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await fs.access("/usr/bin/python3", constants.X_OK)
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-network-"))
        const socket = path.join(root, "broker.sock")
        const relayPath = path.join(root, "relay.py")
        await Bun.write(relayPath, relay)
        const connections = new Set<net.Socket>()
        const server = net.createServer((client) => {
          connections.add(client)
          client.once("close", () => connections.delete(client))
          handle(client, policy, options).catch(() => client.destroy())
        })
        server.maxConnections = 64
        await new Promise<void>((resolve, reject) => server.listen(socket, resolve).once("error", reject))
        return { root, socket, relayPath, server, connections }
      },
      catch: (cause) => new Error("failed to start restricted network broker", { cause }),
    }),
    (broker) =>
      Effect.promise(async () => {
        broker.connections.forEach((connection) => connection.destroy())
        await new Promise<void>((resolve) => broker.server.close(() => resolve()))
        await fs.rm(broker.root, { recursive: true, force: true })
      }),
  )

async function handle(client: net.Socket, policy: Policy, options: BrokerOptions) {
  const header = await readHeader(client)
  const lines = header.split("\r\n")
  const request = lines[0]?.split(" ") ?? []
  if (request.length !== 3 || request[2] !== "HTTP/1.1") throw new Error("invalid proxy request")
  const entries = lines.slice(1, -2).map((line) => {
    const split = line.indexOf(":")
    if (split < 1) throw new Error("invalid proxy header")
    return [line.slice(0, split).trim().toLowerCase(), line.slice(split + 1).trim()] as const
  })
  if (new Set(entries.map((entry) => entry[0])).size !== entries.length) throw new Error("duplicate proxy header")
  const headers = new Map(entries)
  if (headers.has("proxy-authorization") || headers.has("transfer-encoding") || headers.has("upgrade"))
    throw new Error("unsupported proxy request")
  if (headers.has("content-length") && headers.get("content-length") !== "0") throw new Error("proxy body denied")
  const endpoint = request[0] === "CONNECT" ? authority(request[1]) : httpEndpoint(request[1], headers.get("host"))
  const rule = ruleFor(policy, endpoint.host, endpoint.port)
  if (!rule) throw new Error("endpoint denied")
  const addresses = net.isIP(endpoint.host)
    ? [{ address: endpoint.host, family: net.isIP(endpoint.host) }]
    : await (options.lookup ?? dns.lookup)(endpoint.host, { all: true, verbatim: true })
  const allowed = addresses.filter((item) => authorizeAddress(rule, item.address))
  if (allowed.length !== addresses.length || allowed.length === 0) throw new Error("destination address denied")
  const remote = await (options.connect ?? connect)(allowed[0]!.address, endpoint.port, allowed[0]!.family)
  if (request[0] === "CONNECT") {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    remote.pipe(client)
    client.pipe(remote)
    return
  }
  remote.write(header.replace(/^\S+\s+https?:\/\/[^/]+/i, `${request[0]} `))
  remote.pipe(client)
  client.once("data", () => {
    client.destroy(new Error("one HTTP request is allowed per proxy connection"))
    remote.destroy()
  })
}

const authority = (value: string) => {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value)
  if (!match) throw new Error("invalid CONNECT authority")
  return { host: normalizeHost(match[1] ?? match[2]!), port: Number(match[3]) }
}

const httpEndpoint = (target: string, hostHeader?: string) => {
  const url = new URL(target)
  if (url.protocol !== "http:" || url.username || url.password || !hostHeader) throw new Error("invalid HTTP proxy URL")
  const host = authority(hostHeader.includes(":") ? hostHeader : `${hostHeader}:80`)
  if (normalizeHost(url.hostname) !== host.host || Number(url.port || 80) !== host.port)
    throw new Error("authority mismatch")
  return host
}

const readHeader = (socket: net.Socket) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => reject(new Error("proxy header timeout")), 5_000)
    const data = (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      const buffer = Buffer.concat(chunks)
      const end = buffer.indexOf("\r\n\r\n")
      if (size > 16_384 || end < 0) return size > 16_384 ? reject(new Error("proxy header too large")) : undefined
      clearTimeout(timer)
      socket.off("data", data)
      if (end + 4 !== buffer.length) return reject(new Error("pipelining denied"))
      resolve(buffer.toString("latin1"))
    }
    socket
      .on("data", data)
      .once("error", reject)
      .once("close", () => reject(new Error("proxy disconnected")))
  })

const connect = (host: string, port: number, family: number) =>
  new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({
      host,
      port,
      family,
      lookup: (_hostname, _options, callback) => callback(null, host, family),
    })
    socket.setTimeout(10_000, () => socket.destroy(new Error("connect timeout")))
    socket
      .once("connect", () => {
        socket.setTimeout(0)
        resolve(socket)
      })
      .once("error", reject)
  })
