export * as ConfigSandbox from "./sandbox.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export const Filesystem = Schema.Struct({
  read: Schema.Array(Schema.String).pipe(optional),
  write: Schema.Array(Schema.String).pipe(optional),
  deny: Schema.Array(Schema.String).pipe(optional),
})
export interface Filesystem extends Schema.Schema.Type<typeof Filesystem> {}

export const NetworkRule = Schema.Struct({
  host: Schema.String,
  ports: Schema.NonEmptyArray(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  includeSubdomains: Schema.Boolean.pipe(optional),
  private: Schema.Boolean.pipe(optional),
})
export type NetworkRule = typeof NetworkRule.Type

export const ToolNetwork = Schema.Union([
  Schema.Literals(["none", "full"]),
  Schema.Struct({
    mode: Schema.Literal("restricted"),
    allow: Schema.Array(NetworkRule),
  }),
])
export type ToolNetwork = typeof ToolNetwork.Type

export const Network = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    tools: ToolNetwork.pipe(optional),
    provider: Schema.Literals(["configured", "disabled"]).pipe(optional),
    mcp: Schema.Struct({ allow: Schema.Array(Schema.String).pipe(optional) }).pipe(optional),
  }),
])
export type Network = typeof Network.Type

export const Options = Schema.Struct({
  enabled: Schema.Boolean.pipe(optional),
  filesystem: Filesystem.pipe(optional),
  network: Network.pipe(optional),
  environment: Schema.Literals(["safe", "all"]).pipe(optional),
})
export interface Options extends Schema.Schema.Type<typeof Options> {}

export const Selection = Schema.Union([Schema.Boolean, Options])
export type Selection = typeof Selection.Type
