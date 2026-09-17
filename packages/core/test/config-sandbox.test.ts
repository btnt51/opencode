import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "../src/v1/config/config"
import { Schema } from "effect"

describe("sandbox network config", () => {
  test("accepts separated provider, tool, and MCP policies", () => {
    const config = Schema.decodeUnknownSync(ConfigV1.Info)({
      sandbox: {
        network: {
          tools: "none",
          provider: "configured",
          mcp: { allow: ["local-filesystem", "company-mcp"] },
        },
      },
      mcp: {
        "local-filesystem": {
          type: "local",
          command: ["local-mcp"],
          sandbox: { network: "none" },
        },
        "company-mcp": { type: "remote", url: "https://mcp.example.test" },
      },
    })
    expect(config.sandbox).toMatchObject({
      network: {
        tools: "none",
        provider: "configured",
        mcp: { allow: ["local-filesystem", "company-mcp"] },
      },
    })
  })

  test("continues to accept legacy network booleans", () => {
    expect(Schema.decodeUnknownSync(ConfigV1.Info)({ sandbox: { network: false } }).sandbox).toEqual({
      network: false,
    })
    expect(Schema.decodeUnknownSync(ConfigV1.Info)({ sandbox: { network: true } }).sandbox).toEqual({ network: true })
  })
})
