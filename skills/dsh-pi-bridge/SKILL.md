---
name: dsh-pi-bridge
description: Install plugins across hosts - load a pi coding agent package into DeepSeek Harness (DSH),
  or load a DSH plugin bundle into pi, as callable tools, slash commands and skills. Use when the user asks
  to install a plugin from the other ecosystem, says "pi 插件装到 dsh" or "dsh 插件装到 pi", mentions
  cross-host plugins, pi_install, dsh_install, /dsh-install, or wants one plugin to work in both hosts.
---

# Cross-host plugin bridge

One package that installs into both hosts, and lets each host use the other's plugins.

A plugin runs inside **its own host**, where that host's APIs are real, and the other
side calls it. Nothing is reimplemented against stubs: a package that needs a model,
a provider credential or another bundle gets the genuine thing from its own host.

## Which half you are in

- In DSH: tools `pi_install`, `pi_preview`, `dsh_install`, `bridge_list`, `bridge_remove`,
  `bridge_status`.
- In pi: `/dsh-install`, `/dsh-preview`, `/bridge-list`, `/bridge-remove`, plus the
  `dsh_install` and `dsh_preview` tools so an agent can install one unattended.

Sources use one grammar on both sides: `npm:<pkg>[@ver]`,
`git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, a repository URL, or a
local path.

## Use a pi package in DSH

1. `pi_preview({ source })` - one call, says what will actually arrive.
2. `pi_install({ source, prefix? })` - the package is materialised with its real
   dependencies and loaded inside a supervised `pi --mode rpc` process the bridge
   starts. Every tool pi reports comes back as a DSH tool that forwards the call.
3. Call it. `web_web_search`, `fetch_content` and friends then behave exactly as they
   do for a pi user, using pi's own provider configuration.

The bridge starts that pi process on first use and reuses it. `bridge_status` says
whether it is alive; a package that needs pi-only surfaces (TUI renderers, shortcuts)
reports what did not cross rather than pretending.

## Use a DSH bundle in pi

A DSH bundle needs DSH services, so it has to run inside a live DSH session:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                 # DSH opens a loopback endpoint
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...     # pi forwards to it
```

Then `dsh_install({ source })` asks that session to load the bundle against its real
scope and registers one forwarding tool in pi per capability. The endpoint is off by
default, so an ordinary DSH start opens no port.

**If no DSH session is reachable**, `dsh_install` falls back to replaying the bundle's
registrations in pi and says so in the report. That is a degraded mode: tool names
arrive, but anything the bundle does with `ctx.llm`, another bundle, or the skill
registry runs against bridge stand-ins and can fail when used. Do not present the
result as a working install - tell the user which mode they got and how to get the
real one. The same rule holds on restart: a bundle that had been forwarded is never
silently restored as stubs.

## After installing

Registrations are live in the current session immediately. The registry at
`~/.dsh-pi-bridge/bridges.json` lets each host restore what it recorded when the
plugin loads, so an install survives a restart - restoring uses the same path that
installed it. Restore is cache-only: host startup never waits on a download, and a
pruned cache reports the bridge as unavailable. `restoreOnLoad: false` in the bundle
config turns it off. Other DSH clients pick up new tools after a restart, because they
build their tool list at start.

Nothing is written into either host's settings. `bridge_remove` forgets a bridge;
tools already registered in a running process stay until restart, because silently
unregistering host state is worse than leaving it visible.

## What does not cross

- Host UI: DSH browser pages / `ctx.slots`, pi's TUI renderers, `ctx.ui`, shortcuts.
- Registering a model provider or adapter: it lands in the host running the package,
  which is the point of not translating.
- A DSH bundle with nothing callable (a pure settings or UI overlay). Preview says so
  instead of inventing capability.

TypeScript compiles with `module.stripTypeScriptTypes` (Node 22.13+): no toolchain and
no download.

## When something fails

`npm test` runs every offline suite and is the fastest way to tell a package problem
apart from a bridge problem. `bridge_status` reports the supervised pi process and what
it holds. A report naming no tools means the package needed pi-only or DSH-only
surfaces - read its registrations.

## Security

A bridged package executes code with your permissions inside its own host, and it
reaches that host's real services - that is what makes it work, and what makes the
trust requirement real. Read a package's source before installing it. The loopback
endpoint is off unless requested; anything able to reach that port can invoke the
tools the session has loaded, so keep it off unless you need it.
