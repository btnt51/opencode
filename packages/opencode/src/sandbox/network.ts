export * as SandboxNetwork from "./network"

import dns from "dns/promises"
import fs from "fs/promises"
import { rmSync } from "fs"
import net from "net"
import os from "os"
import path from "path"
import { domainToASCII } from "url"

export type Rule = {
  host: string
  ports: number[]
  includeSubdomains?: boolean
  private?: boolean
}

export type Policy = { mode: "restricted"; allow: Rule[] }

const PORT = 18080
const MAX_HEADER = 64 * 1024
const brokers = new Map<string, Promise<{ directory: string; socket: string }>>()

export async function broker(policy: Policy) {
  const rules = policy.allow.map(normalizeRule)
  const key = JSON.stringify(rules)
  const existing = brokers.get(key)
  if (existing) return existing
  const started = startBroker(rules).catch((error) => {
    brokers.delete(key)
    throw error
  })
  brokers.set(key, started)
  return started
}

export function normalizeRule(rule: Rule) {
  const host = normalizeHost(rule.host)
  if (!host) throw new Error(`invalid restricted network host: ${rule.host}`)
  if (!rule.ports.length) throw new Error(`restricted network rule requires at least one port: ${host}`)
  if (rule.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`invalid restricted network port for ${host}`)
  }
  return { ...rule, host, ports: Array.from(new Set(rule.ports)) }
}

export function normalizeHost(input: string) {
  const value = input.trim().replace(/\.$/, "").toLowerCase()
  if (!value || value.includes("%")) return
  if (net.isIP(value)) return value
  const ascii = domainToASCII(value)
  if (!ascii || ascii.length > 253) return
  if (ascii.split(".").some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))
    return
  return ascii
}

export function allowed(rules: ReturnType<typeof normalizeRule>[], host: string, port: number) {
  const normalized = normalizeHost(host)
  if (!normalized) return
  return rules.find(
    (rule) =>
      rule.ports.includes(port) &&
      (normalized === rule.host ||
        (!!rule.includeSubdomains && !net.isIP(rule.host) && normalized.endsWith(`.${rule.host}`))),
  )
}

export function publicAddress(address: string) {
  const version = net.isIP(address)
  if (version === 4) {
    const [a, b, c, d] = address.split(".").map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 0 && c === 0) return false
    if (a === 192 && b === 0 && c === 2) return false
    if (a === 192 && b === 168) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    if (a === 198 && b === 51 && c === 100) return false
    if (a === 203 && b === 0 && c === 113) return false
    return !(a === 255 && b === 255 && c === 255 && d === 255)
  }
  if (version !== 6) return false
  const value = address.toLowerCase()
  if (value === "::" || value === "::1") return false
  if (value.startsWith("::ffff:")) return false
  const first = Number.parseInt(value.split(":")[0] || "0", 16)
  if ((first & 0xfe00) === 0xfc00) return false
  if ((first & 0xffc0) === 0xfe80) return false
  if ((first & 0xff00) === 0xff00) return false
  if (value.startsWith("2001:db8:") || value.startsWith("2001:0:") || value.startsWith("2001:1:")) return false
  return true
}

function connectableAddress(address: string) {
  if (net.isIP(address) === 4) {
    const first = Number(address.split(".")[0])
    return first !== 0 && first < 224
  }
  if (net.isIP(address) !== 6) return false
  const value = address.toLowerCase()
  return value !== "::" && !value.startsWith("ff")
}

async function startBroker(rules: ReturnType<typeof normalizeRule>[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-network-"))
  await fs.chmod(directory, 0o700)
  const socket = path.join(directory, "broker.sock")
  const server = net.createServer((client) => accept(client, rules))
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, () => {
      server.off("error", reject)
      resolve()
    })
  })
  await fs.chmod(socket, 0o600)
  server.unref()
  process.once("exit", () => {
    server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, socket }
}

function accept(client: net.Socket, rules: ReturnType<typeof normalizeRule>[]) {
  let buffered = Buffer.alloc(0)
  const reject = (message: string, status = "403 Forbidden") => {
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}\n`)
  }
  const read = async (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    if (buffered.length > MAX_HEADER)
      return reject("Sandbox network policy denied: malformed request", "431 Request Header Fields Too Large")
    const end = buffered.indexOf("\r\n\r\n")
    if (end < 0) return
    client.off("data", read)
    const header = buffered.subarray(0, end + 4)
    const body = buffered.subarray(end + 4)
    const line = header.toString("latin1", 0, header.indexOf("\r\n"))
    const match = /^(CONNECT|[A-Z]+) ([^ ]+) HTTP\/1\.[01]$/.exec(line)
    if (!match) return reject("Sandbox network policy denied: malformed request", "400 Bad Request")
    const target = parseTarget(match[1], match[2])
    if (!target) return reject("Sandbox network policy denied: malformed destination", "400 Bad Request")
    const rule = allowed(rules, target.host, target.port)
    if (!rule) return reject(`Sandbox network policy denied: host=${target.host} port=${target.port}`)
    const addresses = await dns.lookup(target.host, { all: true, verbatim: true }).catch(() => [])
    const candidates = addresses.filter((item) =>
      rule.private ? connectableAddress(item.address) : publicAddress(item.address),
    )
    if (!candidates.length) return reject(`Sandbox network policy denied: host=${target.host} port=${target.port}`)
    const upstream = await connect(candidates, target.port).catch(() => undefined)
    if (!upstream)
      return reject(`Sandbox network connection failed: host=${target.host} port=${target.port}`, "502 Bad Gateway")
    upstream.on("error", () => client.destroy())
    client.on("error", () => upstream.destroy())
    if (match[1] === "CONNECT") client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    else upstream.write(rewrite(header, target.url!))
    if (body.length) upstream.write(body)
    client.pipe(upstream).pipe(client)
  }
  client.on("data", read)
  client.on("error", () => undefined)
}

function parseTarget(method: string, input: string) {
  if (method === "CONNECT") {
    const match = /^(?:\[([^\]]+)\]|([^:\[\]]+)):(\d{1,5})$/.exec(input)
    if (!match) return
    const host = normalizeHost(match[1] ?? match[2])
    const port = Number(match[3])
    if (!host || port < 1 || port > 65535) return
    return { host, port }
  }
  if (!URL.canParse(input)) return
  const url = new URL(input)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) return
  const host = normalizeHost(url.hostname)
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
  if (!host || !port) return
  return { host, port, url }
}

function rewrite(header: Buffer, url: URL) {
  const lines = header.toString("latin1").split("\r\n")
  lines[0] = lines[0].replace(/^([A-Z]+) [^ ]+ (HTTP\/1\.[01])$/, `$1 ${url.pathname}${url.search} $2`)
  return Buffer.from(
    [
      lines[0],
      `Host: ${url.host}`,
      ...lines.slice(1).filter((line) => !/^(?:host|proxy-(?:authorization|connection)):/i.test(line)),
    ].join("\r\n"),
    "latin1",
  )
}

async function connect(addresses: dns.LookupAddress[], port: number) {
  for (const item of addresses) {
    const socket = await new Promise<net.Socket | undefined>((resolve) => {
      const value = net.createConnection({ host: item.address, port, family: item.family })
      const done = (result?: net.Socket) => {
        value.off("connect", connected)
        value.off("error", failed)
        resolve(result)
      }
      const connected = () => done(value)
      const failed = () => done()
      value.once("connect", connected)
      value.once("error", failed)
    })
    if (socket) return socket
  }
  throw new Error("connection failed")
}

export const relay = `import os
import signal
import socket
import subprocess
import sys
import threading

broker, shell, command, cwd = sys.argv[1:5]
server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", ${PORT}))
server.listen()

def copy(source, destination):
    try:
        while data := source.recv(65536):
            destination.sendall(data)
    except OSError:
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass

def relay(client):
    try:
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        upstream.connect(broker)
    except OSError:
        client.close()
        return
    threading.Thread(target=copy, args=(client, upstream), daemon=True).start()
    threading.Thread(target=copy, args=(upstream, client), daemon=True).start()

def accept():
    while True:
        try:
            relay(server.accept()[0])
        except OSError:
            return

threading.Thread(target=accept, daemon=True).start()
child = subprocess.Popen([shell, "-c", command], cwd=cwd)
for item in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(item, lambda current, frame: child.send_signal(current))
code = child.wait()
server.close()
sys.exit(code)
`

export function environment() {
  const proxy = `http://127.0.0.1:${PORT}`
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: "", no_proxy: "" }
}
