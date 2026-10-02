# OpenCode V2 privacy and outbound-network audit

**Audit date:** 2026-10-02  
**Scope:** the checked-out monorepo, with emphasis on the shipped V2 CLI/server, Core,
AI transports, browser application, and desktop application. Tests, documentation,
CI, hosted Console/Stats services, and installers were classified separately from the
end-user runtime. This is a source audit, not a proof about every transitive dependency.

## Executive summary

- **Can conversation data reach an unconfigured third party? YES.** Built-in agents may
  invoke `webfetch` and `websearch`; the Explore agent explicitly allows both without an
  ask rule (`packages/core/src/plugin/agent.ts:114-124`). The requested URL or search
  query is model-produced and can encode prompt, file, or tool data. Search goes to a
  selected search service, not to the configured LLM/MCP boundary.
- **Telemetry:** no CLI/Core analytics sender was found. The browser app does initialize
  Sentry whenever the build supplies `VITE_SENTRY_DSN`, and error boundaries capture
  exceptions (`packages/app/src/entry.tsx:48-64`, `packages/app/src/app.tsx:78-81`). This
  is build-time opt-in, but not a runtime user permission.
- **Fallback proxy / remote UI:** the former class of `proxy("https://app.opencode.ai…")`
  was not found. The CLI embeds its UI assets. `/api` and `/openapi.json` are sent only
  to the local API and unknown API routes become 404; other paths serve the embedded SPA
  and only GET/HEAD are accepted (`packages/cli/src/services/web-ui.ts:6-37`).
- **Crash reporting:** browser Sentry is present as above. Desktop fatal-renderer records
  include formatted error, current URL, version, platform, and OS
  (`packages/app/src/shell/errors/error.tsx:235-258`). Whether a particular desktop build
  subsequently uploads that record was **NOT VERIFIED** dynamically.
- **Hidden LLM provider / remote embeddings:** no second automatic LLM, embedding, or
  reranking provider was identified in the V2 session execution path. Title generation
  and compaction call the selected session LLM (`packages/core/src/session/title.ts:74`,
  `packages/core/src/session/compaction.ts:653`). This is not a dependency-level proof.
- **Automatic network calls:** model-catalog refresh is enabled by default and polls
  `https://models.opencode.ai/api.json`; it is disabled by
  `OPENCODE_DISABLE_MODELS_FETCH` (`packages/core/src/models-dev.ts:282,319-350`,
  `packages/cli/src/server-process.ts:104-107`). Automatic update inspection is enabled
  unless policy or `OPENCODE_DISABLE_AUTOUPDATE` disables it, and calls opencode.ai with
  installed version metadata (`packages/cli/src/services/updater.ts:239-245,428-451`).

The requested deny-by-default policy is therefore **not implemented**. There is no single
outbound policy gate covering HTTP, WebSocket, MCP, subprocesses, browser resources, and
plugins.

## Method and limits

Static searches covered `fetch`, Effect `HttpClient`, Request, WebSocket, proxy agents,
process spawning, hard-coded URL schemes, telemetry/error SDK names, update/share/search
terms, package scripts, and runtime dependencies across the repository. Generated model
snapshots and documentation produce many non-executable URLs and were separated from
runtime findings. Network-capable subprocesses and arbitrary plugin/tool commands mean a
finite list of TypeScript HTTP calls cannot establish non-egress by itself.

Dynamic interception was **NOT VERIFIED**: a representative end-to-end run with a local
provider and local MCP was not completed in this environment. Consequently, this report
does not claim syscall-level completeness, DNS coverage, or behavior of every transitive
dependency/provider SDK.

## Runtime network egress map

| Source | Destination | Trigger | Data | Default | Allowed? | Evidence |
|---|---|---|---|---|---|---|
| Session model request | selected provider base URL (HTTP or WebSocket) | each physical model attempt | system instructions, history, prompt, attachments, tool calls/results | when user runs a model | YES | `packages/core/src/session/runner/step.ts:101-107`; `packages/core/src/session/model-request.ts:303-324` |
| MCP remote transport | configured MCP URL | configured remote MCP starts/calls | MCP requests, tool args; credentials for that MCP | configuration required | YES | `packages/core/src/mcp/index.ts:380-425`; `packages/core/src/mcp/oauth.ts:165-183` |
| MCP stdio | configured child command | configured local MCP starts | environment inherited according to process options; JSON-RPC over stdio | configuration required | REVIEW | `packages/core/src/mcp/stdio.ts:74-91` |
| Model catalogue | `models.opencode.ai/api.json` or `OPENCODE_MODELS_URL` | server startup and periodic refresh | User-Agent, IP, catalog cache state/timing | **on** | NO | `packages/core/src/models-dev.ts:282,319-350,400-433` |
| CLI update service | `opencode.ai/update/api/...` | startup/default command inspection | channel, artifact, package manager, current version, IP | **on** except local/disabled policy | NO | `packages/cli/src/services/updater.ts:239-245,428-451,494-503` |
| Ripgrep bootstrap | GitHub release URL | bundled/system ripgrep unavailable | OS/arch/version, IP | conditional automatic | NO | `packages/core/src/ripgrep/binary.ts:35-41,103-119` |
| `webfetch` tool | arbitrary model/user URL | tool call after permission evaluation | URL (possibly sensitive query), IP; ordinary response returns to conversation/LLM | tool installed; permission depends on agent | OPTIONAL/REVIEW | `packages/core/src/tool/plugin/webfetch.ts:105-135`; Explore allows it at `packages/core/src/plugin/agent.ts:120` |
| `websearch` tool | Exa, Firecrawl, Tinyfish, Tavily, Parallel, or configured service | tool call / search request | search query, credentials, IP; results return to LLM | no query until invoked; Explore allows | OPTIONAL/REVIEW | `packages/core/src/plugin/websearch/exa.ts:8,25-55`; `packages/core/src/tool/plugin/websearch.ts:62-139` |
| Browser Sentry | build-time DSN | handled/unhandled UI error | error object, stack, URL/breadcrumb data allowed by SDK config | only builds with DSN | NO/REVIEW | `packages/app/src/entry.tsx:48-64`; `packages/app/src/app.tsx:78-81` |
| Markdown favicons | `www.google.com/s2/favicons` | rendering an external link | linked hostname, browser IP/referrer behavior | automatic in affected renderer | NO | `packages/session-ui/src/components/markdown.tsx:306-318` |
| Browser images/media | arbitrary HTTPS host | rendering remote content in conversation/UI | URL, IP, referrer/cookies subject to browser policy | CSP permits | NO/REVIEW | `packages/cli/src/services/web-ui.ts:39-42` (`img-src https:`, `connect-src *`) |
| Telegram notification | `api.telegram.org` | explicitly configured notification | configured text/event content and bot token | off | OPTIONAL | `packages/core/src/notification.ts:86-105` |
| Provider OAuth/login | provider issuer (OpenAI, xAI, GitHub, GitLab, Poe, etc.) | explicit connection flow/refresh | OAuth codes/tokens/device identifiers | off until login | OPTIONAL | e.g. `packages/core/src/plugin/provider/poe.ts:128-155`, `packages/core/src/plugin/provider/openai.ts:190-205` |
| Well-known integration | user-supplied origin | explicit experimental well-known integration | request headers and origin-visible IP | off | OPTIONAL | `packages/core/src/wellknown.ts:62-91` |
| Remote skills | configured index/URL | configured discovery/activation | requested URL, IP; downloaded executable instructions | configuration required | OPTIONAL/REVIEW | `packages/core/src/skill/discovery.ts:69-101` |
| Plugins / shell / tools | arbitrary network | plugin code or allowed shell command (`curl`, `ssh`, package managers, etc.) | anything readable by that process | depends on plugin/permission | REVIEW | `packages/core/src/integration.ts:625-633`; `packages/core/src/shell.ts:299-315`; `packages/core/src/plugin/sdk.ts` |
| Desktop updater/remote SSH bootstrap | release/registry/GitHub or SSH target | update or explicit SSH connection | version/platform; SSH identity/config; remote workspace traffic | updater build-dependent; SSH explicit | NO/OPTIONAL | `packages/desktop/src/main/updater/platform.ts:39-48`; `packages/desktop/src/main/remote/cli.ts:68-122`; `packages/desktop/src/main/ssh/controller.ts:141-170` |

## Sensitive conversation data flow

1. The server accepts `text`, files, agents, skills, metadata, delivery, and resume fields
   at `POST /api/session/{id}/prompt` and passes them to `Session.prompt`
   (`packages/server/src/handlers/session.ts:304-326`).
2. Admission publishes durable inbox events; the projector materializes JSON payloads in
   SQLite `session_pending`, and delivered messages in `session_message`. The latter stores
   the complete typed message in a JSON `data` column
   (`packages/core/src/session/sql.ts:79-105`; `packages/core/src/session/projector.ts:206-240`).
3. History is read in sequence from `session_message`
   (`packages/core/src/session/history.ts:62-94`). Instructions, history, selected agent,
   model and tools are assembled into a provider request. The runner performs the explicit
   `llm.stream(request, options)` call (`packages/core/src/session/runner/step.ts:101-107`).
4. HTTP hooks can inspect and mutate the complete serialized provider Request/Response;
   WebSocket hooks can inspect handshake and frames. Thus installed plugins are inside the
   conversation trust boundary (`packages/core/src/session/model-request.ts:291-324`;
   `packages/plugin/src/effect/session.ts:90-149`).
5. Provider stream events are published into durable assistant/tool records. Tool results,
   including MCP results and file/shell output, become subsequent model-visible history
   (`packages/core/src/session/runner/step.ts:104-130`). They therefore go to the selected
   provider during normal agent continuation.
6. Local HTTP/SSE clients and the UI can retrieve session messages/events. The server
   request logger sees request metadata; source inspection did not show it deliberately
   logging request bodies (`packages/server/src/process.ts:35-40`). Local errors can still
   retain causes and stack data. Browser Sentry may receive error objects when enabled.
7. A model can place sensitive material in a `webfetch` URL or web-search query, or in an
   allowed shell/plugin call. These are additional sinks, not the selected provider/MCP.

### Storage and event exposure

- Messages and pending inputs are local SQLite JSON (`packages/core/src/session/sql.ts:79-105`).
- Session bus/projector consumers and HTTP event subscribers can see relevant durable
  events. Plugins receive broad host editors/hooks, and provider request hooks see complete
  provider payloads.
- MCP receives only calls directed to its advertised tools/resources, but its result is
  placed back into conversation history and normally sent to the selected LLM on the next
  step. No built-in default remote MCP endpoint was identified; the web-search adapters
  named “MCP” are separate built-in search providers and are still external sinks.
- Logs are primarily local. No Core remote log exporter was found. Logs include IDs,
  provider transport diagnostics, update versions, and error causes; error causes can
  contain URLs or provider diagnostics (`packages/core/src/session/model-transport.ts:173-192,351-378`).

## Findings

### HIGH — model-callable internet tools extend the privacy boundary

- **Files/lines:** `packages/core/src/plugin/agent.ts:114-124`,
  `packages/core/src/tool/plugin/webfetch.ts:105-135`,
  `packages/core/src/tool/plugin/websearch.ts:62-139`.
- **Behavior/data/destination:** Explore allows arbitrary web fetch/search. Model-generated
  URL/query may contain prompt, source, filename, tool output, or secrets and is sent to an
  arbitrary host or search vendor.
- **Trigger/default:** model tool call; the permission is explicitly `allow` for Explore.
- **Why:** violates provider/MCP-only egress and makes prompt injection an exfiltration path.
- **Fix:** deny both tools by default in strict mode; require per-host/per-query user approval
  and pass every request through a central capability-aware outbound policy.

### HIGH — plugins and subprocesses are unrestricted code/network trust boundaries

- **Files/lines:** `packages/core/src/integration.ts:625-633`,
  `packages/core/src/mcp/stdio.ts:74-91`, `packages/core/src/shell.ts:299-315`.
- **Behavior:** configured plugins/integrations/MCP commands and model-approved shell tools
  can start arbitrary programs. Those programs can use sockets or `curl`, inherit selected
  environment, read accessible files, and bypass TypeScript HTTP wrappers.
- **Trigger/default:** explicit installation/configuration or a permitted tool call; not a
  hidden default sender, but broader than an endpoint allowlist.
- **Fix:** document plugins/stdio MCP as full-code trust; strict mode should sandbox network,
  scrub environment, require signed/local artifacts, and bind each child to capabilities.

### HIGH — browser error reporting can upload sensitive error context

- **Files/lines:** `packages/app/src/entry.tsx:48-64`,
  `packages/app/src/app.tsx:78-81`, `packages/app/src/shell/errors/error.tsx:235-258`.
- **Behavior/data:** Sentry is initialized by build environment and errors are captured.
  Errors/stacks/URLs may contain server URLs, identifiers, filenames, or provider/tool text.
- **Default:** absent without DSN; enabled automatically in a build containing DSN. Runtime
  user opt-in and data scrubber were not found.
- **Fix:** compile Sentry out of privacy builds; otherwise require runtime consent and add
  `beforeSend` redaction plus URL/header/body denial tests.

### HIGH — frontend permits unexpected third-party requests

- **Files/lines:** `packages/session-ui/src/components/markdown.tsx:306-318`,
  `packages/cli/src/services/web-ui.ts:39-42`.
- **Behavior/data:** rendering links loads Google favicons, revealing linked domains and the
  client IP. CSP permits all HTTPS images and all connect destinations, so remote markdown
  media/blob restoration or compromised UI code is not constrained to the local server.
- **Default:** automatic on relevant rendered content.
- **Fix:** remove remote favicons, proxy only through an explicit safe fetch capability (or
  use local icons), and set `connect-src 'self'` / `img-src 'self' data: blob:` in strict mode.

### MEDIUM — automatic model catalogue request

- **Files/lines:** `packages/core/src/models-dev.ts:282,319-350,400-433`,
  `packages/cli/src/server-process.ts:104-107`.
- **Behavior/data:** periodic request to models.opencode.ai sends IP and OpenCode User-Agent.
- **Default:** enabled; opt-out by `OPENCODE_DISABLE_MODELS_FETCH=1`.
- **Fix:** bundled catalogue only in strict mode; make refresh explicit opt-in.

### MEDIUM — automatic update request

- **Files/lines:** `packages/cli/src/services/updater.ts:239-245,428-451,494-503`.
- **Behavior/data:** opencode.ai receives channel, artifact, distribution/current version,
  timing and IP. Failures are local errors; no fallback provider was found.
- **Default:** enabled unless local build, policy disabled, or
  `OPENCODE_DISABLE_AUTOUPDATE=1`.
- **Fix:** disable by default in privacy mode and expose a manual update capability.

### MEDIUM — conditional automatic binary download

- **Files/lines:** `packages/core/src/ripgrep/binary.ts:35-41,103-119`.
- **Behavior:** downloads ripgrep from GitHub when a usable binary is unavailable.
- **Data:** platform/architecture/version, User-Agent/IP; not conversation content.
- **Fix:** package binary at install/build time or fail closed in strict mode.

### MEDIUM — CSP is not an outbound policy

- **File/lines:** `packages/cli/src/services/web-ui.ts:39-42`.
- **Behavior:** `connect-src *` and HTTPS images allow direct browser third-party access.
- **Fix:** make the shipped CSP self-only and add narrowly scoped origins only after explicit
  user configuration.

### LOW — no fallback API proxy found; local behavior is correct

- **File/lines:** `packages/cli/src/services/web-ui.ts:13-25`.
- **Behavior:** unknown `/api/*` routes become local 404. The embedded SPA fallback is only
  used outside API paths, accepts GET/HEAD, and does not forward method, body, headers,
  cookies, authorization, query, SSE, or WebSocket traffic to a remote UI.
- **Recommendation:** preserve this invariant with regression tests.

### INFO — expected build/install/CI networking

- Root `postinstall` runs a local node-pty repair script (`package.json:22-23`); Bun/npm
  dependency resolution is build/install network access.
- The installer queries opencode.ai and npm and downloads release archives
  (`install:171-191,291-335`).
- Release/stats/CI scripts contact GitHub, npm, Cloudflare, PostHog and package registries;
  these are not invoked by ordinary CLI runtime. `script/stats.ts:11-20` is a PostHog
  sender for the maintainer stats script, not evidence of CLI telemetry.
- Desktop remote-host bootstrap downloads CLI artifacts only for an explicitly configured
  SSH workflow (`packages/desktop/src/main/remote/cli.ts:68-122`).

## Provider and MCP boundaries

Provider endpoints are defined in `packages/ai/src/providers` and
`packages/ai/src/protocols`; the resolved selected model supplies the request endpoint.
Supported hard-coded defaults include OpenAI, Anthropic, Google/Gemini/Vertex, Azure,
Bedrock, OpenRouter, xAI, Groq, DeepSeek, Mistral, Together, Fireworks, Cloudflare,
Baseten, Cerebras, Moonshot, MiniMax, Z.AI, and OpenCode Zen. These are provider catalogue
choices, not simultaneous broadcast targets. HTTP and WebSocket provider hooks remain a
plugin-visible boundary.

No implicit second embedding, moderation, semantic-index or reranking request was found.
Text search and filesystem indexes are local. Titles, generated text and compaction are
additional requests to the selected session provider, so conversation-derived data does
leave during those operations, but to that same provider.

MCP remote URLs and credentials originate in configuration/integration resolution; stdio
MCP starts a configured command. No default general MCP server was found. However, built-in
web-search integrations have hard-coded endpoints (`mcp.exa.ai`, `mcp.firecrawl.dev`,
`agent.tinyfish.ai`, `api.tavily.com`, `search.parallel.ai`). They must not be confused with
configured MCPs in a policy review.

## Hard-coded external runtime domains

This list excludes comments, schema identifiers, test fixtures, documentation-only links,
hosted Console/Stats/WWW services, and generated model snapshots. A domain’s presence does
not mean it is contacted automatically.

| Class | Domains |
|---|---|
| Automatic product metadata | `models.opencode.ai`, `opencode.ai` (update API), `github.com` (conditional ripgrep/release), `registry.npmjs.org` (desktop/remote install) |
| Search/tools | `mcp.exa.ai`, `mcp.firecrawl.dev`, `agent.tinyfish.ai`, `api.tavily.com`, `search.parallel.ai`, arbitrary URL supplied to webfetch |
| Providers | `api.openai.com`, `auth.openai.com`, `chatgpt.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `aiplatform.googleapis.com`, `www.googleapis.com`, `*.openai.azure.com`, `*.cognitiveservices.azure.com`, `bedrock-runtime.*.amazonaws.com`, `bedrock-mantle.*.api.aws`, `openrouter.ai`, `api.x.ai`, `auth.x.ai`, `api.groq.com`, `api.deepseek.com`, `api.mistral.ai`, `api.together.xyz`, `api.fireworks.ai`, `api.cloudflare.com`, `ai-gateway.vercel.sh`, `inference.baseten.co`, `api.cerebras.ai`, `api.deepinfra.com`, `api.meta.ai`, `api.moonshot.ai`, `api.minimax.io`, `api.z.ai`, `api.typesafe.ai`, `api.kilo.ai`, `api.llmgateway.io`, `integrate.api.nvidia.com`, `api.poe.com`, `poe.com`, `zenmux.ai`, `api.digitalocean.com`, `cloud.digitalocean.com`, `*.snowflakecomputing.com` |
| Media APIs in AI package | `api.assemblyai.com`, `api.eu.assemblyai.com`, `api.deepgram.com`, `api.cartesia.ai`, `api.elevenlabs.io`, `api.stability.ai`, `api.bfl.ai`, `api.eu.bfl.ai`, `api.us.bfl.ai`, `api.replicate.com`, `queue.fal.run`, `api.dev.runwayml.com` |
| OAuth/source control | `api.github.com`, `api.githubcopilot.com`, dynamic GitHub Enterprise domains, `gitlab.com`, dynamic GitLab instance URL |
| UI/user links/resources | `www.google.com` (favicon service), `discord.com`, `x.com`, arbitrary HTTPS image/connect host permitted by CSP |
| Optional notification | `api.telegram.org` |
| Local/non-public | `localhost`, `127.0.0.1`, `::1`, `tauri.localhost` |

Dynamic custom provider, MCP, integration well-known, notification proxy, server connection,
webfetch, SSH and plugin URLs are intentionally not enumerable and must be policy-checked at
runtime.

## Environment variables with network impact

| ENV | Default | Purpose / impact |
|---|---|---|
| `OPENCODE_DISABLE_MODELS_FETCH` | false | Truthy disables automatic models.opencode.ai catalogue fetch (`packages/cli/src/server-process.ts:104-107`). |
| `OPENCODE_MODELS_URL` | `https://models.opencode.ai` | Replaces catalogue origin (`packages/cli/src/server-process.ts:104-106`). |
| `OPENCODE_MODELS_PATH` | unset | Supplies local catalogue, but does not by itself prove remote fetching is disabled. |
| `OPENCODE_DISABLE_AUTOUPDATE` | false | `1`/`true` disables CLI automatic update inspection (`packages/cli/src/services/updater.ts:428-435`). |
| `VITE_SENTRY_DSN` | unset/source-build dependent | Enables browser Sentry (`packages/app/src/entry.tsx:48-64`). |
| `VITE_SENTRY_ENVIRONMENT`, `VITE_SENTRY_RELEASE` | mode/version | Tags Sentry reports. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, lowercase forms, `NO_PROXY` | process environment | Routes WebSocket/notification/provider-capable traffic through proxies; the proxy sees destination and possibly TLS CONNECT metadata (`packages/core/src/effect/websocket-constructor.ts:38-79`; `packages/core/src/notification.ts:135-158`). |
| Provider API-key/project/region variables | unset | Activate/authorize the corresponding configured provider; exact names are integration-specific. |
| Search keys such as `EXA_API_KEY` | unset | Enable optional search integrations (`packages/core/src/plugin/websearch/exa.ts:31-45`). |

The repository has many provider-specific environment variables; an exhaustive generated
ENV inventory was **NOT VERIFIED** and should be produced as a machine-readable follow-up.

## Negative-path assessment

- Unknown and misspelled API routes: local 404, no remote fallback
  (`packages/cli/src/services/web-ui.ts:13-19`).
- Provider WebSocket failure: falls back to HTTP for the same selected provider route, not
  a different provider (`packages/core/src/session/model-transport.ts:290-312,351-378`).
- Provider/MCP failure, timeout, reconnect, HTTP 500, restore: source inspection found local
  retry/reconnect/error paths, not a fallback cloud provider. Full dynamic proof is
  **NOT VERIFIED**.
- Uncaught browser exception: may go to Sentry when the DSN is built in; this is an external
  error-reporting path.

## Git history and removed-feature residue

The working tree still contains V1 database fields/migrations for `share_url` and
`session_share`, but this audit did not identify a V2 runtime share uploader. These are
migration/storage residues (`packages/core/src/database/schema.gen.ts:195` and
`packages/core/src/database/migration/20260127222353_familiar_lady_ursula.ts:89-96`). A
commit-by-commit upstream archaeology sufficient to attribute every cloud/telemetry/UI
change was **NOT VERIFIED**.

## Recommended strict-mode architecture

Implement a process-level `NetworkPolicy` with default deny:

```text
OpenCode runtime -> NetworkPolicy
  allow: exact configured provider origins + required provider OAuth origins
  allow: exact configured remote MCP origins
  allow: localhost, 127.0.0.1, ::1
  deny: everything else
```

1. Route every Core/AI HTTP client and WebSocket constructor through the policy. Validate
   every redirect hop, resolved IP (including DNS rebinding), scheme, port, credentials,
   proxy and CONNECT destination.
2. Create explicit capabilities: `provider`, `provider-auth`, `mcp`, `web-fetch`,
   `web-search`, `updates`, `catalog-refresh`, `remote-ui`, `notifications`, `sharing`,
   `telemetry`, `plugin-download`, `binary-download`, and `ssh`.
3. In `privacy/offline` mode enable only configured provider/MCP plus loopback. Disable
   model catalogue fetch, auto-update, Sentry, remote favicons/media, web tools, remote
   skills, notifications, installer/bootstrap downloads and SSH unless individually enabled.
4. Treat subprocesses as a separate egress plane. Apply OS sandboxing/firewall rules;
   wrappers around `fetch` cannot constrain `curl`, language runtimes, native plugins, MCP
   stdio servers or shell commands. Scrub credentials/environment by default.
5. Lock browser CSP to self, prohibit service-worker/network drift, and mediate remote media
   through an approved server capability.
6. Add deterministic tests with a fake DNS resolver, HTTP/HTTPS/WebSocket/MCP/provider
   endpoints, redirect and proxy cases, plus syscall-level CI capture. Assert zero DNS/TCP/
   UDP beyond the allowlist during startup, prompt, response, file read, shell tool, MCP,
   failures, restart and restore.
7. Emit a local audit log of denied/allowed destinations and capability/reason, never request
   bodies, headers, credentials, prompt text or tool results.

## Strict conclusion

```text
Can conversation contents leave the machine through any path other than
the configured LLM provider or configured MCP servers?

YES
```

Reasons: model-callable web fetch/search can transmit model-derived content to arbitrary or
built-in third-party destinations; browser rendering makes third-party favicon/media
requests; Sentry-enabled builds upload error context; and trusted plugins, shell tools and
stdio MCP subprocesses can create unrestricted connections. Automatic catalogue/update/
binary-download traffic additionally violates the requested network policy even when it
does not normally contain conversation bodies. No centralized deny-by-default outbound
enforcement exists, and end-to-end dynamic interception was not completed.
