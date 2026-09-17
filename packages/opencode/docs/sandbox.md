# Sandbox mode

OpenCode can isolate commands executed by the shell tool with Linux bubblewrap. This mode is opt-in and fails closed: when it is requested on an unsupported platform or `bwrap` is unavailable, the command is not run.

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "read": ["/workspace/shared"],
      "write": ["/workspace/project"],
      "deny": ["/workspace/project/secrets"]
    },
    "network": false,
    "environment": "safe"
  }
}
```

The active workspace and `/tmp` are writable by default. Configured `read` paths are read-only and configured `write` paths are writable. Paths are canonicalized before mounting, allowed paths beneath a denied path are rejected, and the rest of the host filesystem is absent. System executable and library directories are mounted read-only, together with the minimal host account, name-resolution, and TLS certificate files needed by ordinary command-line tools. `/proc` and `/sys` are not mounted. A private network namespace disables networking by default; `network: true` shares host networking. The namespace and mounts apply to the whole descendant process tree.

The default `safe` environment retains only terminal, locale, time-zone, and executable-search variables. `environment: "all"` explicitly passes the existing shell environment and may expose credentials.

Sandbox containment replaces shell and external-directory approval prompts for sandboxed shell commands; other tool permissions remain active. Direct in-process file tools, PTYs, LSP servers, plugins, MCP servers, formatters, and OpenCode's own provider traffic are not placed in this command sandbox and retain their existing permission and trust model.

## Guarantees and limitations

Linux with unprivileged user namespaces and bubblewrap is the only supported implementation. Bubblewrap supplies mount, user, PID, IPC, UTS, cgroup, and (unless enabled) network namespaces; no Docker daemon or root privilege is required. Availability still depends on the host permitting unprivileged namespaces. This initial implementation does not provide hostname allowlists, syscall filtering beyond the namespace boundary, resource limits, or isolation for non-shell subprocess entry points. Do not enable network access for untrusted commands unless their filesystem access alone provides an adequate boundary.
