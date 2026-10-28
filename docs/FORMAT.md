# The two official formats, and what a translator may claim

This project exists because one host can install the other's plugins. That only
works if the shapes are read from each host's own specification rather than from
the examples that happen to be at hand. This document records both specifications,
the measurements behind them, and the resulting translation table.

Everything below was read from files on disk. Where a number appears, it was
counted; where a rule is stated, the file that states it is named.

## 1. What a DSH plugin is, officially

### 1.1 The package names a patch, not an entry point

A DSH plugin is an npm package carrying a `dsh` key:

```json
{
  "name": "noatmark-dsh-plugin",
  "main": "dist/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`dsh.bundle.patch` is the contract. The module entry (`main`) is only where a
*row* may point; it is not itself the plugin. Treating `main` as the plugin - as
this bridge did until it read the patches - silently composes one module out of
however many the bundle declares.

### 1.2 The unit of installation is a row

`cordis.patch.yml` is a list of operations, and only two kinds exist anywhere in
the distribution: `insert` and `- id` (modify an existing row).

```yaml
- insert:
    - id: acp
      name: '@deepseek-ai/dsh-acp'
      inject: [acpAppStartup]
      config:
        provider: deepseek-official
        model: deepseek-v4-flash

- id: session-title-llm
  disabled: true
```

Measured across the 18 patch files shipped in DSH 0.2.1-rc.2:

| Fact | Count |
|---|---|
| inserted rows | 250 |
| rows carrying `config` | 70 |
| rows declaring `inject` on the row itself | 7 |
| rows disabled by a `!!js` expression | 18 |
| rows naming a **subpath** instead of the package root | 6 |
| top-level `- id` operations (modify a host row) | 43 |

The six subpath names are real and load-bearing:
`@deepseek-ai/dsh-plugin-manager/tools`,
`@deepseek-ai/dsh-tool-subagent-control/list-agents`,
`@deepseek-ai/dsh-headless/startup`,
`@deepseek-ai/dsh-tool-subagent/model-selection-settings`.

A row's fields are `id`, `name`, `inject`, `config`, `disabled`. A patch
replaces the targeted row's whole `config` rather than merging into it; rows are
addressed by `id`, last write wins; row order carries no load semantics.

`disabled` is not always a boolean. It may be a `!!js` expression such as
`!ctx.get('profileContext')` or `process.platform === 'win32'`. That expression
selects a **host profile**, not the user's intent, and a translator cannot
evaluate it: it would be running arbitrary code from a package to decide whether
to load that package. This bridge composes such a row and reports the expression
in the plugin report, because dropping it would make a working plugin look empty.

Modify operations target the host's own rows (`system-prompt`,
`session-title-llm`). They are host configuration, and pi has no counterpart for
them; they are reported, never translated.

### 1.3 A plugin module exports name, inject, apply

```js
export const name = 'noatmark-text-hygiene'
export const inject = ['tools']
export function apply (ctx, config) { /* register into ctx.* */ }
```

`apply` may be async. `inject` lists the services the plugin needs; the row may
add to it. A tool is registered through `defineTool` from
`@deepseek-ai/dsh-tools`:

```js
{
  name, description,
  parameters: { text: { type: 'string', required: true, description: '…' } },
  output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: value }] },
  async execute (args, exec) { return canonicalValue }
}
```

`execute` takes **two** arguments - the validated arguments and a
`ToolRunContext` carrying identity, cancellation and context deferral - and
returns the canonical value declared by `output.schema`, not a rendered result.

### 1.4 The parameter DSL and its one hard rule

From `@deepseek-ai/dsh-tools/lib/types/schema.d.ts`, the authorable node kinds
are: `string`, `number`, `integer`, `boolean`, `null`, `array` (with `items`),
`object`, `json` (unconstrained), and `oneOf` (exact one, two or more branches).
Requiredness is a per-property `required: true`; the parameter root is an
implicit open object.

Compiling a nested `object` without `additionalProperties` is a **hard error**,
verified against DSH's own compiler:

```
unsupported JSON schema: parameters.config.additionalProperties must be
explicitly true or false
```

There is no `anyOf`. `json` compiles to `{}`, i.e. any lossless JSON value.

## 2. What a pi package is, officially

Sources: `docs/packages.md` and `docs/extensions.md` inside
`@earendil-works/pi-coding-agent@1.4.0`, and
`dist/core/extensions/types.d.ts` for the exact signatures.

A pi package is an ordinary directory or npm package that exposes resources from
conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`) or
declares them under a `pi` key:

```json
{ "name": "my-pi-package", "keywords": ["pi-package"],
  "pi": { "extensions": ["./src/extension.ts"] } }
```

A path may be a file or a glob. A **directory** is an extension only when it
holds `index.ts` or `index.js` - an adapter named `index.mjs` is not discovered,
which is why the generated adapter names its file explicitly.

An extension is a module whose default export is a factory receiving
`ExtensionAPI`; it may be async. Tools are registered as:

```js
pi.registerTool({
  name, label, description, parameters,          // label is required
  async execute (toolCallId, params, signal, onUpdate, ctx) {
    return { content: [{ type: 'text', text }], details }
  }
})
```

`label` and `details` are required; `content` is what the model sees. The host
supplies `@earendil-works/pi-*` and `typebox` as peer packages with a `*` range.

Events are named and typed; the ones relevant to a bridge are `session_start`,
`session_shutdown`, `tool_call` (which may return `{ block: true, reason }`),
`tool_result`, `turn_start`, `turn_end`, `agent_start`, `agent_end`,
`resources_discover`. Crucially, `docs/extensions.md` says a factory must not
start processes or sockets - long-lived resources belong in `session_start` and
must be released in `session_shutdown`.

## 3. The translation table

`≈` means lossy in a stated direction; `= ` means the same meaning on both sides.

| Concept | DSH | pi | Verdict |
|---|---|---|---|
| Plugin unit | a row in `cordis.patch.yml` | a package / an extension file | **row → one pi extension unit**, composed per row |
| Plugin identity | row `id`, row `name` (may be a subpath) | package name + extension file | = , resolved through `exports` |
| Plugin config | row `config`, replaces wholesale | none (extension reads its own) | passed into `apply(ctx, config)` |
| Module contract | `name`, `inject`, `apply(ctx, config)` | `export default (pi) => {}` | = , `inject` is checked, not faked |
| Tool registration | `ctx.tools.register(defineTool(...))` | `pi.registerTool({...})` | = |
| Tool name | `name` | `name` + required `label` | `label` synthesised from the name |
| Parameters | property map, `required` per property | JSON Schema, `required` array | = , both directions enumerated |
| Parameter `object` | `additionalProperties` **mandatory** | optional, defaults to open | pi→DSH must emit `true` |
| Parameter `null` | real type | `type: 'null'` | = |
| Parameter `oneOf` | `oneOf` | `oneOf` | = |
| Parameter `anyOf` | absent | present | pi→DSH degrades to `json`: permissive, never wrong |
| Parameter `json` | any value | `{}` | = |
| Tool result | canonical value from `execute` | `{ content, details }` | `output.render` produces the content; `details` holds the origin |
| Tool cancellation | `exec.signal` | `signal` | = |
| Tool execution context | `ctx.tools` registry | `ctx.executeTool()` | ≈, both run nested calls through the same hooks |
| Events | `ctx.on` on harness events | `pi.on` on lifecycle events | **each side keeps its own**: in the forwarding architecture the plugin runs in its own host and receives real events, so nothing needs to cross. Only the degraded replay path maps names, and it says so - the payload the handler sees is the local host's, not the one it registered for |
| Slash commands | `ctx.commands.register({ name, description, input?, handler })` | `pi.registerCommand(name, { description, handler })` | = , with one shape difference: DSH's handler receives a `CommandInvocation` (`{ name, rawInput }`), pi's receives the raw string - the bridge supplies each handler its own shape |
| Blocking a call | pre-execute waterfall | `tool_call` returning `{ block }` | possible, but the payload shapes differ |
| Skills | `ctx.skills.registerProvider` | `resources_discover` → `skillPaths` | = , directory passed through |
| Slash commands | `ctx.commands.register` | `pi.registerCommand` | = |
| Model providers | `ctx.llm.registerAdapter` | `pi.registerProvider` | not translated: both are host-internal |
| Web routes / UI slots | `ctx.web`, `ctx.slots` | none | **cannot cross**: pi has no such surface |
| Sessions / agents / storage | `ctx.sessions`, `ctx.agents`, `ctx.storage` | different objects entirely | **cannot cross** without the real host |
| Host lifetime | the plugin's own process | extension runs inside pi | the pi side supplies a real DSH; the DSH side supplies a real pi |

### 3.1 The services a DSH plugin may inject

From every `inject` declaration in DSH 0.2.1-rc.2, in descending frequency:
`tools`, `sessionProjections`, `sessions`, `slots`, `loader`, `remote`, `agents`,
`typert`, `workingDirectory`, `locale`, `connection`, `webServer`, `subprocess`,
`commands`, `cmdlineArgs`, `web`, `subagents`, `skills`, `profileContext`, `llm`,
`credentials`, `systemPrompt`, `storage`, `speechToText`, `sessionPersistence`,
`otel`, `fs`, `deepseekAccount`, `worktrees`, `userQuestions`, `uiWorkspace`,
`typertGateway`, `tokenMeter`, `storageDomain`, `sessionQuery`, `sandboxPolicy`,
`remoteAccess`, and two dotted names.

Only a handful of these have a pi analogue. This is why the bridge forwards to a
**real** host instead of standing in for one: a plugin that injects `llm`,
`sessions` or `slots` is not "mostly working" against stand-ins, it is a
different program. See `README.md` for what that costs on each side.

## 4. What "complete" means, field by field

"Installed" and "translated" are different claims. A plugin is translated
completely when every declarative field it made a promise with survives the trip.
This is the whole list for a tool, taken from the two type files.

| DSH | pi | Status |
|---|---|---|
| `name`, `description` | same | exact |
| `parameters` (property map) | JSON Schema | exact, including `null`, `oneOf`, `const`, and the mandatory `additionalProperties` |
| `output.schema` | `outputSchema` + `structuredContent` | exact: a programmatic caller gets the value, not prose |
| `deferLoading` | `exposure: "deferred"` | exact |
| `isConcurrencySafe(args)` | `executionMode: "sequential"` | conservative: pi's mode is static, so a declared classifier maps to the only always-true claim |
| `timeoutMs` | none | DSH still enforces its own budget inside the registry; the value rides along for display |
| `execute(args, exec)` | `execute(callId, params, signal, onUpdate, ctx)` | exact, with the caller's signal propagated |
| `projectContent`, `finalizeContent` | applied inside DSH | exact, once calls go through `ctx.tools.execute` |
| `presentCall`, `presentResult`, `presentationMeta` | none | **not translatable**: pi renders with TUI components, DSH with presentation metadata |
| `inject` services (`llm`, `sessions`, `agents`, …) | none | irrelevant in practice: the plugin runs inside a real DSH, so they are real, not stubbed |

The last row is the one worth pausing on. Forwarding to a live host is what makes
"complete" achievable at all: the plugin's own view of the world - `ctx.llm`,
sessions, the skill registry, subagents - is the genuine one, because it is a
genuine DSH. What cannot cross is the *presentation*: a plugin that draws a
settings panel or a market page has no pi surface to draw on.

### 4.1 Measured, not assumed

Two of these rows were defects until they were measured:

- Calls from pi reached `def.execute` directly, which skips pre-policy, guards,
  post-policy and the tool's own `finalizeContent`. The registry method
  `ctx.tools.execute(input)` is the documented entry point and runs all of them -
  visible at `dsh-tools/lib/index.js:3212` versus the raw body call at `:3406`.
  Forwarding now uses the registry, and `/health` reports `callPath` so a caller
  can assert it got the faithful path instead of merely an answer.
- `ToolExecutionInput.signal` is required. Omitting it makes the registry read
  `undefined.aborted` and fail the call before the tool body runs, which is how
  the requirement was found.

The pi→DSH direction had the mirror-image defect: every pi tool crossed into DSH
through a fixed `{ ok, result }` text envelope, so a tool that declared an
`outputSchema` lost its structure the moment it was bridged. It now keeps its own
output schema, and the canonical value crosses unchanged.

## 5. What this means for the project

Reading the specifications changed four things, each of which was a defect
before:

1. **Bundles are composed by row.** `src/patch-rows.js` parses the patch,
   `src/compose.js` mounts each row with its own name, `config` and `inject`, and
   reports the rows it does not compose. Loading `main` once was wrong for 6 of
   the 250 official rows and for every multi-row bundle.
2. **A row config reaches `apply`.** 70 of 250 rows carry one; ignoring it turns
   a configured plugin into an unconfigured one.
3. **`additionalProperties` is emitted.** Without it, every pi tool with a nested
   object parameter failed to register in DSH - a hard error, on the direction
   the project exists to provide.
4. **A conditional row is reported, not evaluated.** Running a package's `!!js`
   expression to decide whether to load that package is a security decision this
   bridge is not entitled to make on the user's behalf.

What remains true regardless of format work: route-only bundles (a market UI, a
settings panel) register web routes rather than tools. They are active inside
their own host and have nothing for the other side to forward. That is a property
of the plugin, not a bug in the translator, and the report says so.
