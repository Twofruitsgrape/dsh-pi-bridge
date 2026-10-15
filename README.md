# dsh-pi-bridge

**One plugin, two hosts — and each host can install the other’s plugins.**

Install it into [pi](https://pi.dev) (`pi install npm:dsh-pi-bridge`) or into
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh plugin add dsh-pi-bridge`),
and you get the same behaviour either way, plus a bridge that loads packages from *the other
ecosystem* as native tools, slash commands and skills.

一份代码，两个宿主：装到 pi 或装到 DSH —— 装完之后，两边的插件可以互相安装。
DSH 里用 `pi_install` 装 pi 的插件，pi 里用 `/dsh-install` 装 DSH 的插件，转成本地宿主的
工具 / 斜杠命令 / 技能。

## Install

```bash
# pi coding agent
pi install npm:dsh-pi-bridge            # or: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DeepSeek Harness
dsh plugin add dsh-pi-bridge            # or install from the plugin panel: github:Twofruitsgrape/dsh-pi-bridge
```

Restart the host afterwards. Both keywords (`pi-package`, `dsh-plugin`) are declared, so the
package is discoverable in each ecosystem’s own market.

## What you get in each host

| | pi | DSH |
|---|---|---|
| Install from the other side | `/dsh-install <source>`, tools `dsh_install` / `dsh_preview` | tools `pi_install` / `pi_preview` / `dsh_install` |
| Manage bridges | `/bridge-list`, `/bridge-remove` | tools `bridge_list` / `bridge_remove` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | same `SKILL.md`, mounted through the skill registry |

Sources use one grammar on both sides: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`,
`github:<owner>/<repo>`, a repository URL, or a local path — exactly what each host already accepts.

```text
dsh> pi_preview({ source: "npm:pi-subagents" })
   package: pi-subagents@0.78.0
   detected: {"pi":["keyword:pi-package","manifest:pi","layout:extensions|skills"]}
     [tool] task     Run a supervised subagent task
     [tool] taskstop Stop a running subagent
     [command] /tasks Show running subagent tasks
     [unsupported] TUI renderer (host-specific)

dsh> pi_install({ source: "npm:pi-subagents" })
   bridged npm:pi-subagents as pi-subagents@0.78.0
     tools: pisubagents_task, pisubagents_taskstop
     commands: /pisubagents_tasks
     skipped: event has no DSH equivalent: cache_warming_decision
```

## How it works

```text
resolve      npm registry tarball / shallow git clone / local copy -> ~/.dsh-pi-bridge cache
mirror       a private build tree, so a bridged package never imports a real host
stub         every foreign host import becomes an inert stand-in, or a real bridge shim
compile      TypeScript -> ESM with node:module stripTypeScriptTypes (no toolchain, no download)
capture      load the package against a recording host API and collect what it registers
replay       install those registrations onto the local host, converting schema both ways
```

A DSH tool declaration carries a property spec map (`{ text: { type: ‘string’, required: true } }`)
that `@deepseek-ai/dsh-tools` compiles to JSON Schema; a pi tool carries the JSON Schema directly
(TypeBox). `src/schema.js` converts both directions, so a bridged tool’s parameters validate in the
host that receives it. Result shapes are projected the same way: pi’s
`{ content: [{ type: ‘text’ }] }` to DSH’s `{ ok, result }` and back.

Skills need no conversion at all — both hosts implement the
[Agent Skills specification](https://agentskills.io/specification), so a `SKILL.md` directory simply
travels. DSH providers are read asynchronously (`list()` is a promise), and the bridge awaits them
before replay, which is how a bundle like `dsh-comsol` crosses into pi intact.

## Verified against real published packages

Measured with `npm run test:all` (offline suites plus the network cases), on the
packages each ecosystem actually ships:

| Bridged package | Direction | Arrived | Reported as not crossing |
|---|---|---|---|
| `pi-web-access@0.40.0` | pi → DSH | 4 tools, 4 commands, 6 event hooks | `registerShortcut`, 4 unmapped events |
| `pi-subagents@0.78.0` | pi → DSH | 3 tools, 19 commands, 4 skill dirs | 33 items listed in the report |
| `@plannotator/pi-extension@0.28.20` | pi → DSH | 216 TS files compiled, 1 skill dir | renderer registrations |
| `dsh-comsol@1.1.1` (git) | DSH → pi / DSH | its `comsol-dsh` skill | — |
| `dsh-cost-meter@1.8.26` | DSH → pi | nothing | correctly reports zero registrations |

The last row is the honest case: a DSH plugin that is purely a UI/service
overlay has nothing to bridge, and the preview says so instead of pretending.

Bridged tools are executed in the tests, not just listed — `web_search` and
`source_check` respond with their own argument-validation errors, which proves
the real package logic runs under the receiving host's tool shape.

## What does not cross

The bridge reports these instead of failing quietly:

- **Model providers and adapters** (`pi.registerProvider`, `ctx.llm.registerAdapter`): wired to host
  internals, not portable.
- **Host UI**: DSH browser pages / `ctx.slots` and pi’s TUI renderers, `ctx.ui`, shortcuts, CLI flags.
- **Events without a counterpart**: a small name map covers the lifecycle overlap
  (`session_start` ↔ `agent/created`, `tool_call` ↔ `tools/pre-execute`, …); anything else is listed.

Registrations land in the current session immediately, and each host replays the recorded bridges when
the plugin loads, so an install survives a restart. That replay is cache-only: host startup never waits
on a network download, and a pruned cache simply reports the bridge as unavailable until it is installed
again. `restoreOnLoad: false` in the bundle config turns replay off.

The bridge keeps its own registry at `~/.dsh-pi-bridge/bridges.json` and writes nothing into either
host’s settings. `bridge_remove` forgets a bridge and deletes its mirror; tools already registered in
the running process stay until restart, because silently unregistering host state would be worse than
leaving it visible.

## Security

A bridged package **executes code with your permissions**, on whichever side you install it — the
same trust requirement every extension host has, doubled because the package came from the other
ecosystem and was not vetted by its market. Read its source before you install it.

The bridge limits the blast radius, it does not remove it: packages load from a private mirror whose
`node_modules` contains only generated stubs, so a bridged extension cannot import the real host API
or reach either host’s configuration through the import map. `preview` first — it resolves and
captures but registers nothing.

## Develop

```bash
```bash
npm test                # offline suites: 40 checks + both host entries + self-bridge
npm run test:offline    # just the pipeline self-test
npm run test:entries    # both real entries and the host-facing surface
npm run test:host       # acceptance against an installed DSH build (see note)
npm run test:network    # real published packages from npm and GitHub
```

`test:host` reads the installed host's own `@deepseek-ai/dsh-tools` from inside its asar, which only
an Electron-patched fs can reach. Run it from a host process (or the harness); under plain Node it
reports an explicit SKIP rather than pretending the host refused us.
```

The self-test builds fixtures by hand — a TypeScript pi extension using the TypeBox builder, and a
DSH bundle using `defineTool` with an async skill provider — then runs the full pipeline against a
recording mock host and executes the bridged tools. `scripts/selfhost-check.mjs` feeds this package's
own DSH entry through the bridge, so the entry conventions are tested by the same machinery a foreign
bundle meets.

Nothing is written outside `~/.dsh-pi-bridge` (override with `DSH_PI_BRIDGE_HOME`). A bridged package
sees only its mirrored build tree, so its relative imports work while its host imports resolve to the
bridge's stubs.

## Layout

```text
index.js              DSH entry: name / inject / apply(ctx), the pi_install tool family
extensions/index.js   pi entry: default(pi) factory, /dsh-install and the dsh_install tools
skills/dsh-pi-bridge/ SKILL.md, shared by both hosts
cordis.patch.yml      DSH bundle mount (the plugin panel toggle target)
src/manifest.js       host detection from keywords, manifests and directory layout
src/resolve.js        npm / git / url / local sources into a cache
src/tar.js            gzipped-tar reader (npm tarballs), no dependency
src/transpile.js      TypeScript -> ESM via node:module, swc/typescript fallback
src/stubs.js          import scanning + inert stub generation
src/typebox-shim.js   TypeBox- and zod-shaped builders over plain JSON Schema
src/capture.js        recording stand-in hosts for both entry conventions
src/schema.js         parameter schema conversion, both directions
src/replay-dsh.js     capabilities -> ctx.tools / ctx.commands / ctx.skills
src/replay-pi.js      capabilities -> pi.registerTool / registerCommand / resources_discover
src/capabilities.js   normalized capability model, event name map, result projection
```

`index.js` imports only `node:` builtins plus this package, and declares `inject: [‘tools’]` with
everything else acquired through `ctx.inject`, so a profile that composes without the skill registry
loses skill mounting rather than failing to load.

## License

MIT
