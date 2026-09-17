# Sandbox mode

OpenCode can isolate agent-controlled shell commands with Linux bubblewrap. This mode is opt-in and fails closed: when it is requested on an unsupported platform, `bwrap` is unavailable, or namespace setup fails, the command is not run.

```jsonc
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "read": ["/workspace/shared"],
      "write": ["/workspace/project"],
      "deny": ["/home/user/.ssh", "/home/user/.gnupg"]
    },
    "network": {
      "tools": "none",
      "provider": "configured",
      "mcp": {
        "allow": ["local-filesystem", "company-mcp"]
      }
    },
    "environment": "safe"
  },
  "mcp": {
    "local-filesystem": {
      "type": "local",
      "command": ["local-filesystem-mcp"],
      "sandbox": { "network": "none" }
    },
    "company-mcp": {
      "type": "remote",
      "url": "https://mcp.example.internal"
    },
    "other-mcp": {
      "type": "remote",
      "url": "https://other.example.com"
    }
  }
}
```

This policy has three separate trust boundaries:

- `tools` controls the whole subprocess tree beneath the shell tool. `"none"` creates a private network namespace; `"full"` deliberately shares host networking. There is no hostname allowlist, proxy, or provider-domain exception.
- `provider` controls provider transport in the trusted OpenCode parent. `"configured"` permits configured provider clients; `"disabled"` rejects provider initialization. Provider traffic never enters the shell namespace.
- `mcp.allow` contains configured MCP names, not hosts. An allowed remote MCP connects from the trusted parent to its statically configured URL. Other MCPs do not connect and report that sandbox policy disabled them. A name which does not exist in `mcp` is a configuration error.

An allowed local MCP is configured code, but is not automatically network-trusted. When the main sandbox is enabled it runs in its own bubblewrap sandbox with networking disabled by default. Set that MCP's `sandbox.network` to `"full"` only when the configured executable requires host networking. Disabled MCP entries remain disabled even if named in the allowlist.

## Boolean migration

The existing boolean form remains supported. `sandbox.network: false` means tool networking is disabled and `sandbox.network: true` means tool networking is unrestricted. Both preserve the historical MCP behavior (enabled configured MCPs may start) and keep configured provider networking available. Use the object form to activate explicit MCP identity policy or to disable provider transport. In object form, omitted `tools` defaults to `"none"`, omitted `provider` defaults to `"configured"`, and omitted `mcp.allow` means no MCP is allowed.

The active workspace and `/tmp` are writable by default. Configured `read` paths are read-only and configured `write` paths are writable. Paths are canonicalized before mounting, allowed paths beneath a denied path are rejected, and the rest of the host filesystem is absent. System executable and library directories are mounted read-only, together with minimal account, name-resolution, and TLS files. `/proc`, `/sys`, `/run`, and `/var/run` are not mounted, so host Docker, Podman, containerd, D-Bus, and SSH-agent sockets are not implicitly exposed.

The default `safe` tool environment retains only terminal, locale, time-zone, and executable-search variables. It does not inherit provider API keys, cloud credentials, proxy variables, OAuth tokens, or `SSH_AUTH_SOCK`. Local MCPs similarly receive the safe base environment plus only environment entries explicitly configured on that MCP. `environment: "all"` explicitly passes the existing environment to shell tools and may expose credentials.

Sandbox containment replaces shell and external-directory approval prompts for sandboxed shell commands; other tool permissions remain active.

## Guarantees and limitations

Provider HTTP clients and allowed remote MCP clients run in the trusted OpenCode parent. Plugins also execute in-process and are trusted code: this sandbox does not protect against a malicious plugin. LSP servers, formatters, PTYs, plugin installation, and other OpenCode-managed subprocesses retain their existing trust model and are not made agent-shell descendants by this policy.

Linux with unprivileged user namespaces and bubblewrap is the only supported implementation. Bubblewrap supplies mount, user, PID, IPC, UTS, cgroup, and (unless explicitly shared) network namespaces; no Docker daemon or root privilege is required. Availability still depends on the host permitting unprivileged namespaces. This implementation does not provide hostname allowlists, syscall filtering beyond the namespace boundary, resource limits, or containment for trusted in-process code.
