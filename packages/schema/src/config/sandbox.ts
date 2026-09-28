export * as ConfigSandbox from "./sandbox.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export const Filesystem = Schema.Struct({
  read: Schema.Array(Schema.String).pipe(optional),
  write: Schema.Array(Schema.String).pipe(optional),
  deny: Schema.Array(Schema.String).pipe(optional),
})
export interface Filesystem extends Schema.Schema.Type<typeof Filesystem> {}

export const Network = Schema.Union([
  Schema.Boolean,
  Schema.Struct({ tools: Schema.Literals(["none", "full"]).pipe(optional) }),
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
