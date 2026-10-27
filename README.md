**English** · [简体中文](docs/readme/README_zh.md) · [繁體中文](docs/readme/README_zh-TW.md) · [日本語](docs/readme/README_ja.md) · [한국어](docs/readme/README_ko.md) · [Türkçe](docs/readme/README_tr.md) · [Русский](docs/readme/README_ru.md) · [Tiếng Việt](docs/readme/README_vi.md) · [ไทย](docs/readme/README_th.md) · [Deutsch](docs/readme/README_de.md) · [Español](docs/readme/README_es.md) · [Français](docs/readme/README_fr.md) · [Українська](docs/readme/README_uk.md) · [Polski](docs/readme/README_pl.md) · [Português (Brasil)](docs/readme/README_pt-BR.md) · [العربية](docs/readme/README_ar.md) · [فارسی](docs/readme/README_fa.md) · [Bahasa Indonesia](docs/readme/README_id.md) · [Italiano](docs/readme/README_it.md) · [Ελληνικά](docs/readme/README_el.md) · [മലയാളം](docs/readme/README_ml.md)

# dsh-pi-bridge

One plugin, two hosts. Install it in pi and it lets pi use DeepSeek Harness
plugins; install it in DSH and it lets DSH use pi plugins. Neither side
translates the other's code in order to run it: a plugin keeps executing inside
its own host, where that host's APIs are real, and the other side calls it.

```text
# pi
pi install npm:dsh-pi-bridge            # or: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

Restart the host afterwards. Both keywords (`pi-package` and `dsh-plugin`) are
declared, so each ecosystem's own market can find the package.

## What you get in each host

| | pi | DSH |
|---|---|---|
| Use a plugin from the other side | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| Manage what is bridged | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | the same `SKILL.md`, mounted through the skill registry |

Sources use one grammar on both sides: `npm:<pkg>[@ver]`,
`git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, a repository URL,
or a local path - exactly what each host already accepts.

A real session, verbatim: a real DSH boot with a real model, installing a real
published pi package.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # a tool from the pi package
  -> live results, fetched by the package itself using pi's own provider config
```

## How it works

### pi plugins inside DSH: a supervised pi process

`pi_install` materialises the package into the bridge cache, installs its real
dependencies, and loads it inside a pi process the bridge supervises
(`pi --mode rpc`). Every registration pi reports back becomes a DSH tool that
forwards the call and returns what pi computed. `SKILL.md` directories mount as
data through `ctx.skills`. The package sees pi's real `registerTool`,
`registerProvider`, model registry and provider credentials, so a package that
calls out to the network or to a model behaves exactly as it does for a pi user.

This replaced an earlier design that replayed registrations onto DSH against
stubbed imports. That version passed every mock test and failed against real
packages, because a stubbed dependency is a tool that cannot run. Forwarding
into the native host is the only version that can be honest about results.

### DSH plugins inside pi: the live DSH session

A DSH bundle needs `ctx.tools`, `ctx.llm` and the skill registry to be the real
things, so `dsh_install` asks the live DSH session to load the bundle itself.
The obstacle is that a bundle installed by the plugin manager is a symlink under
a profile's `node_modules` and cannot resolve bare `@deepseek-ai/*` - measured as
`MODULE_NOT_FOUND`. `src/dsh-loader.js` rewrites exactly those specifiers to the
running build's own modules (the genuine packages, not stubs) and leaves
relative, `node:` and third-party imports alone. The bundle registers with the
host, and pi receives one forwarding tool per capability.

The endpoint is off unless asked for, so an ordinary DSH start opens no port:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # DSH side
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # pi side
```

It binds 127.0.0.1 only and the client refuses a non-loopback endpoint. With no
live DSH reachable, `dsh_install` says so and falls back to translation rather
than pretending it forwarded.

### When neither host is reachable

The bridge still resolves, compiles TypeScript (`node:module`
`stripTypeScriptTypes`, no toolchain download) and captures what a package
registers, so `preview` works anywhere. Registration replay onto the other host
remains for same-host cases and for bundles whose whole payload is data - a DSH
bundle that is only a skill directory has nothing to call remotely, and the skill
simply travels. Both hosts implement the
[Agent Skills specification](https://agentskills.io/specification).

### When only one host is installed

The two directions do not need the same thing from the machine.

On the **DSH side**, a bridged pi package runs inside a real pi process, so pi
itself has to be present. It is located before anything is spawned -
`DSH_PI_BRIDGE_PI` first, then a `@earendil-works/pi-coding-agent` install, then
a `pi` on PATH - and when none of those answers, the bridge installs one itself,
pinned, into `~/.dsh-pi-bridge/vendor`:

```text
no pi runtime found; installing @earendil-works/pi-coding-agent@1.4.0 into ~/.dsh-pi-bridge/vendor
provisioned pi 1.4.0 at ~/.dsh-pi-bridge/vendor/node_modules/@earendil-works/pi-coding-agent
daemon up (pid 11312)
```

Measured on a machine with npm but no pi at all: 18 seconds to a captured
extension context, with no intervention. The install is pinned to one version,
runs with `--omit=dev --ignore-scripts`, and lands outside both hosts, so it can
be deleted without touching an installation. `DSH_PI_BRIDGE_NO_PROVISION=1`
refuses instead of downloading, and says which lookup failed and what to install
- the same message a failed provisioning ends with. Vendoring by hand works too:

```bash
npm install --prefix ~/.dsh-pi-bridge/vendor @earendil-works/pi-coding-agent@1.4.0
```

A vendored copy starts and registers tools with no provider credentials at all -
an empty `PI_CODING_AGENT_DIR` still answers `get_state`, reporting model
`unknown` - so the tool-only half of a pi package works on a machine that has
never configured a model. What needs a key is a tool that itself calls a model.

On the **pi side**, native execution of a DSH bundle needs a live DSH session,
because the bundle wants the real `ctx.tools`, `ctx.llm` and skill registry. With
only pi installed there is no session to use, so the bridge supplies one:

```text
> dsh_install({ source: "<a DSH bundle>" })
bridged <bundle> (via a DSH this bridge started) as dsh-introspect-fixture@1.0.0
  tools: introspect_is_probe, introspect_is_hold
  bridged tools are callable in this session immediately.
```

`@deepseek-ai/dsh` is an installable CLI, so the missing host is provisioned the
same way pi is, into `~/.dsh-pi-bridge/vendor`. A profile of its own (`pi-host`,
created from a shipped template, so no existing profile is touched) gets the
bridge mounted as a bundle, and it is started detached with
`DSH_PI_BRIDGE_DSH_SERVE` pointing at the loopback port the pi side already knows
how to talk to - measured at about three seconds from spawn to `/health`. If a
DSH is already serving, it is reused rather than duplicated.

Two switches exist because supplying a runtime and starting a process are
different acts: `DSH_PI_BRIDGE_NO_PROVISION=1` refuses to download,
`DSH_PI_BRIDGE_NO_AUTOSTART=1` refuses to start a host. With either, the install
falls back to replaying registrations and says which one stopped it - it never
silently reports the degraded mode as native.

Both directions are checked end to end by `tools/dsh-only-e2e.mjs` and
`tools/pi-only-e2e.mjs`, each from an environment built to lack the other host.

### Parameter and result shapes

A DSH tool carries a property spec map
(`{ text: { type: "string", required: true } }`) that `@deepseek-ai/dsh-tools`
compiles to JSON Schema; a pi tool carries JSON Schema directly (TypeBox).
`src/schema.js` converts both ways, and results are projected the same way: pi's
`{ content: [{ type: "text" }] }` to DSH's `{ ok, result }` and back. The host
validates schemas at registration time and accepts a narrower subset than draft
JSON Schema - a `required` marker on a property node, or an object-level
`required` array in an output schema, stops the whole plugin from activating.
Those rules came from probing an installed host, and the suites assert them.

## Verified, and how

Everything above was measured against real hosts, not against a mock:

- a real DSH boot with a real model, installing `npm:pi-web-access` and calling
  `web_web_search` through it (results came from the package's own provider),
- a real DSH session loading a bundle that bare-imports `@deepseek-ai/dsh-tools`,
  then serving it over loopback to a separate process that called its tool,
- pi running this bridge's own DSH entry through the same machinery a foreign
  bundle meets.

Each of those caught a bug no mock could: a missing file in the publish list,
an output schema the host refused so the plugin silently never activated,
`process.execPath` being the app rather than node inside a host, a reinstall
reporting zero capabilities because a daemon had already loaded the package,
a scope that forbids property assignment, a server handler running outside the
fiber that activated the services, and the host refusing a duplicate tool name.

```bash
npm test                # every offline suite
npm run test:offline    # pipeline + both host entries
npm run test:proxy      # daemon, DSH-side and pi-side forwarding
npm run test:host       # against an installed DSH build (see note)
npm run test:network    # real published packages from npm and GitHub
npm run test:live       # the above against an actually running pi
```

Two checks are deliberately not npm scripts, because they build an environment
with one host missing and may provision the other one (hundreds of megabytes):

```bash
node tools/dsh-only-e2e.mjs   # no pi anywhere: a pi package installs and answers
node tools/pi-only-e2e.mjs    # no DSH anywhere: a DSH bundle runs natively
```

`test:host` reads the installed host's own `@deepseek-ai/dsh-tools` from inside
its asar, which only an Electron-patched fs can reach; run it from a host
process. Under plain node it reports an explicit SKIP instead of implying the
host refused us.

The offline suites build their fixtures by hand - a TypeScript pi extension
using the TypeBox builder, a DSH bundle using `defineTool`, a bundle that
bare-imports host packages - then run the whole pipeline against a recording
stand-in and execute the bridged tools. Some rules are asserted statically
because they only surface on a real boot: the shape a host accepts for a schema,
which files must be published, that analysing a bundle starts no process and
binds no port.

### Tested versions

Both hosts are developer previews and both move fast, so the only honest claim is
a pinned pair - not "works with pi and DSH". This is the window everything above
was run in:

| | Version |
|---|---|
| node | 22.22.2 (`engines` also allows >=24) |
| pi | 1.4.0 - `@earendil-works/pi-coding-agent`, entry `dist/bundle/cli.js` |
| DSH | 0.2.1-rc.3 desktop, runtime unpacked at `resources/app`; 0.2.1-rc.2 CLI (`@deepseek-ai/dsh`, the version the bridge provisions when DSH is absent) |
| OS | Windows x64 |

The DSH row is not incidental: 0.2.1-rc.3 moved the runtime out of `app.asar`, and
until the module rewriter learned the unpacked root, every bare `@deepseek-ai/*`
import from a bundle resolved to nothing. A different pair is untested rather than
unsupported, and `bridge_status --verbose` reports the build actually running.

Beyond the suites, both directions were measured over a corpus of real published
packages, at bridge build `4edbe63d6770` (the module-byte fingerprint described in
`src/build-id.js`):

- **pi -> DSH: 166 of 200** packages produced a capability that was then actually
  called. Two further fixes landed after the batch and were each verified on the
  five packages they unblocked, so this is not one continuous re-run.
- **DSH -> pi: 45 of 50** bundles produced capabilities - 33 with tools, 12 with
  commands only. Of the five that produced nothing, two were the package's own
  defect; three are unconfirmed and suspected to be pure-hook bundles.

Neither number has been re-measured since. The current build is `177a4e438f2f`,
which differs from the measured one in how the pi runtime is located (see
"When only one host is installed") - a change that cannot in principle alter which
packages load, but that is a reason to re-run, not a substitute for it. Re-running
is `node tools/batch-pi-to-dsh.mjs <list.json>` against a live host.

## What does not cross

The bridge reports these instead of failing quietly:

- **Host UI**: DSH browser pages / `ctx.slots`, pi's TUI renderers, `ctx.ui`,
  shortcuts, CLI flags.
- **Model adapters registered into a host**: a package that adds a provider does
  that to its own host, which is the point of not translating - pi providers land
  in pi, DSH adapters in DSH.
- **A DSH bundle with nothing callable**: a pure UI or settings overlay has no
  tools to forward. Preview says so rather than inventing capability.
- **Packages that need an interactive host**: a forwarding call can stream
  progress but cannot show a picker on the other side.

## Persistence

Registrations land in the current session immediately. Each host reloads what it
recorded from `~/.dsh-pi-bridge/bridges.json` when the plugin loads, so an
install survives a restart - verified by restarting a DSH session and finding the
bridged tools already there. That reload is cache-only: host startup never waits
on a network download, and a pruned cache reports the bridge as unavailable
rather than hanging. Restarting is also what lets other clients (the Web GUI,
a second window) see the new tools, because they build their tool list at start.
`restoreOnLoad: false` in the bundle config turns it off.

Nothing is written into either host's settings. `bridge_remove` forgets a bridge
and clears its build directory; tools already registered in a running process
stay until restart, because silently unregistering host state is worse than
leaving it visible.

## Security

A bridged package **executes code with your permissions** on the side it runs
in - the same requirement every extension host has, heightened because the
package came from the other ecosystem and was not vetted by its market. Read
its source first; `preview` resolves and inspects without registering anything.

Forwarding does not sandbox the package: it runs with the full trust of its own
host, which is why it works. The loopback endpoint is bound to 127.0.0.1, is
off unless you set `DSH_PI_BRIDGE_DSH_SERVE`, and the client refuses to talk to
a non-loopback address. Anything able to reach that port can invoke the tools
the session has loaded, so keep it off unless you need it.

## Layout

```text
index.js                DSH entry: name / inject / apply(ctx), the pi_* tools
extensions/index.js     pi entry: default(pi) factory, the dsh_* tools and commands
skills/dsh-pi-bridge/   SKILL.md, shared by both hosts
cordis.patch.yml        DSH bundle mount (the plugin panel toggle target)
daemon/run.mjs          supervised pi process; the loopback front for its tools
daemon/bootstrap.js     loaded inside pi by its real extension loader
src/proxy.js            DSH side: start/reuse the daemon, forward a call
src/dsh-loader.js       DSH side: load a bundle at runtime against the live scope
src/serve.js            DSH side: loopback endpoint for the other host
src/dsh-host-client.js  pi side: talk to a live DSH session
src/resolve.js          npm / git / url / local sources into the cache, with deps
src/load.js             build a mirror tree, compile TS, install real dependencies
src/manifest.js         host detection from keywords, manifests and layout
src/capture.js          recording stand-in hosts for both entry conventions
src/schema.js           parameter schema conversion, both directions
src/capabilities.js     normalized capability model, result projection
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          reload recorded bridges on host start
src/stubs.js            import scanning and stub generation for preview
src/tar.js              gzipped-tar reader, no dependency
src/transpile.js        TypeScript -> ESM via node:module
```

`index.js` imports only `node:` builtins plus this package, and declares
`inject: ["tools"]` - the only service it requires. Skills and settings are
reached through `ctx.inject` behind a capability check, so a profile that does
not compose the skill registry simply mounts no skills instead of failing to
start.

## License

MIT
