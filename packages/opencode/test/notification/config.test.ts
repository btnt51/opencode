import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigParse } from "@/config/parse"
import { ConfigVariable } from "@/config/variable"

const telegram = {
  type: "telegram" as const,
  enabled: true,
  botToken: "token",
  chatId: "123",
  events: { attention: true, completed: { enabled: true, after: "30s" }, failed: true, retry: false },
}

describe("notification config", () => {
  test("accepts a keyed Telegram destination", () => {
    expect(ConfigParse.schema(ConfigV1.Info, { notification: { personal: telegram } }, "test").notification).toEqual({
      personal: telegram,
    })
  })

  test("accepts omitted, direct, environment, and explicit proxy modes", () => {
    const values = [
      telegram,
      { ...telegram, proxy: { mode: "direct" } },
      { ...telegram, proxy: { mode: "environment" } },
      { ...telegram, proxy: { mode: "url", url: "http://user:password@127.0.0.1:7890" } },
      { ...telegram, proxy: { mode: "url", url: "https://localhost:8443" } },
    ]
    expect(
      values.map(
        (personal) => ConfigParse.schema(ConfigV1.Info, { notification: { personal } }, "test").notification?.personal,
      ),
    ).toHaveLength(values.length)
  })

  test("rejects missing, invalid, and unsupported explicit proxy URLs", () => {
    const values = [
      { mode: "url" },
      { mode: "url", url: "not a URL" },
      { mode: "url", url: "socks5://127.0.0.1:1080" },
      { mode: "url", url: "socks5h://127.0.0.1:1080" },
    ]
    for (const proxy of values) {
      expect(() =>
        ConfigParse.schema(ConfigV1.Info, { notification: { personal: { ...telegram, proxy } } }, "test"),
      ).toThrow()
    }
  })

  test("allows disabled destinations without credentials", () => {
    expect(
      ConfigParse.schema(ConfigV1.Info, { notification: { personal: { type: "telegram", enabled: false } } }, "test")
        .notification?.personal.enabled,
    ).toBe(false)
  })

  test("rejects missing enabled credentials and invalid duration", () => {
    expect(() =>
      ConfigParse.schema(
        ConfigV1.Info,
        { notification: { personal: { type: "telegram", enabled: true, chatId: "123" } } },
        "test",
      ),
    ).toThrow()
    expect(() =>
      ConfigParse.schema(ConfigV1.Info, { notification: { personal: { ...telegram, chatId: undefined } } }, "test"),
    ).toThrow()
    expect(() =>
      ConfigParse.schema(
        ConfigV1.Info,
        { notification: { personal: { ...telegram, events: { completed: { enabled: true, after: "soon" } } } } },
        "test",
      ),
    ).toThrow()
  })

  test("environment substitution resolves credentials before validation", async () => {
    const text = await ConfigVariable.substitute({
      text: JSON.stringify({
        notification: {
          personal: {
            type: "telegram",
            enabled: true,
            botToken: "{env:OPENCODE_TELEGRAM_BOT_TOKEN}",
            chatId: "{env:OPENCODE_TELEGRAM_CHAT_ID}",
          },
        },
      }),
      type: "virtual",
      source: "test",
      dir: process.cwd(),
      env: { OPENCODE_TELEGRAM_BOT_TOKEN: "secret", OPENCODE_TELEGRAM_CHAT_ID: "123" },
    })
    const config = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(text, "test"), "test")
    expect(config.notification?.personal.botToken).toBe("secret")
    expect(config.notification?.personal.chatId).toBe("123")
  })
})
