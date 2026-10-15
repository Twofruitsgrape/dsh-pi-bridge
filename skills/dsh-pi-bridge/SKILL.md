---
name: dsh-pi-bridge
description: Install plugins across hosts - load a pi coding agent package into DeepSeek Harness (DSH),
  or load a DSH plugin bundle into pi, as native tools, slash commands and skills. Use when the user asks
  to install a plugin from the other ecosystem, says "pi 插件装到 dsh" or "dsh 插件装到 pi", mentions
  cross-host plugins, pi_install, dsh_install, /dsh-install, or wants one plugin to work in both hosts.
---

# Cross-host plugin bridge

One package that installs into both hosts, and lets each host load the other's plugins.

## Which half you are in

- In DSH the bridge exposes tools: `pi_install`, `pi_preview`, `dsh_install`, `bridge_list`, `bridge_remove`.
- In pi the bridge exposes `/dsh-install`, `/dsh-preview`, `/bridge-list`, `/bridge-remove`, plus the
  `dsh_install` and `dsh_preview` tools so an agent can install one unattended.

## Install from the other host

1. Preview first - it costs one call and says what will actually arrive: `pi_preview({ source })` in
   DSH, `/dsh-preview <source>` in pi. The report lists tools, commands, skills, events, and anything
   that will be skipped.
2. Install: `pi_install({ source })` in DSH, `/dsh-install <source>` or `dsh_install({ source })` in pi.
3. Read the report. `skipped` entries are the honest boundary: model providers, host UI slots, web
   routes and TUI rendering are host-specific and never cross.

Sources use one grammar on both sides: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`,
`github:<owner>/<repo>`, a repository URL, or a local path.

## What crosses and what does not

| Capability | pi to DSH | DSH to pi |
|---|---|---|
| Tools | yes, parameters converted | yes, schema converted |
| Slash commands | yes | yes |
| Skills | yes (shared SKILL.md format) | yes |
| Lifecycle events | mapped where a counterpart exists, else reported | same |
| Model providers, host UI, web routes | reported as unsupported | reported as unsupported |

TypeScript is compiled with `module.stripTypeScriptTypes` (Node 22.13+): no toolchain and no download
is needed on the DSH side. Foreign host imports become inert stubs inside a private mirror build, so a
bridged package cannot reach into either host's real services or configuration.

## After installing

Registrations are live in the current session. Other clients and new processes see them after a host
restart. The bridge keeps its own registry at `C:/Users/ALICE/.dsh-pi-bridge/bridges.json` and remounts recorded
skills on load; it never writes into either host's settings.

To undo: `bridge_remove({ source })` / `/bridge-remove <source>` forgets the mirror build. Tools already
registered in the running process stay until restart - the bridge does not unregister host state
behind your back.

## When a load fails

`npm test` runs the offline pipeline self-test and is the fastest way to tell a package problem apart
from a bridge problem. A load error names the file. `nothing registrable found` means the bundle needed
a host service the bridge could not stand in for - read its `inject` list.
