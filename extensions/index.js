/**
 * dsh-pi-bridge — pi entry: the extension half of the plugin.
 *
 * pi loads this file through the package's pi.extensions manifest and calls the
 * default factory with an ExtensionAPI. The factory registers the cross-host
 * installer as pi slash commands plus two model-callable tools, so a pi user or
 * agent can install a DSH plugin bundle into the running pi session.
 *
 * A DSH bundle is loaded against a recording stand-in host (src/capture.js) and
 * its registrations are replayed onto pi's real API (src/replay-pi.js).
 * DSH-only capabilities are reported rather than dropped in silence.
 *
 * @module extensions/index.js
 */
import { loadForeign } from "../src/load.js";
import { replayIntoPi } from "../src/replay-pi.js";
import { CACHE_ROOT } from "../src/resolve.js";
import { restoreIntoPi } from "../src/restore.js";
import { dshHostStatus, dshHostLoad, dshHostCall, dshParamsToSchema, dshEndpoint } from "../src/dsh-host-client.js";

const REGISTRY = CACHE_ROOT + "/bridges.json";

/** Remember bridges in our own cache, never in pi's settings. */
async function readState() {
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(REGISTRY, "utf8"));
  } catch {
    return { bridges: {} };
  }
}

async function writeState(state) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(CACHE_ROOT, { recursive: true });
  await writeFile(REGISTRY, JSON.stringify(state, null, 2), "utf8");
}

function shortPrefix(name) {
  const s = String(name)
    .replace(/^@[^/]+\//, "")
    .replace(/^dsh-/, "")
    .replace(/^pi-/, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return s || "bridged";
}

function formatReport(spec, captured, report) {
  const lines = ["bridged " + spec + " as " + captured.info.name + "@" + captured.info.version];
  lines.push("  tools: " + (report.tools.length ? report.tools.join(", ") : "none"));
  lines.push("  commands: " + (report.commands.length ? report.commands.map((c) => "/" + c).join(", ") : "none"));
  lines.push("  skills: " + (report.skills.length ? report.skills.join(", ") : "none"));
  if (report.events.length) lines.push("  events: " + report.events.join(", "));
  if (report.skipped.length) lines.push("  skipped: " + report.skipped.join("; "));
  if (captured.errors && captured.errors.length) lines.push("  load errors: " + captured.errors.join("; "));
  lines.push("  bridged tools are callable in this session immediately.");
  return lines.join("\n");
}

async function previewText(captured) {
  const lines = [
    "package: " + captured.info.name + "@" + captured.info.version,
    "detected hosts: " + JSON.stringify(captured.info.signals),
  ];
  for (const cap of captured.capabilities || []) {
    lines.push("  [" + cap.kind + "] " + cap.name + " - " + String(cap.description || "").slice(0, 100));
  }
  for (const dir of captured.skillDirs || []) lines.push("  [skill-dir] " + dir);
  for (const e of captured.events || []) lines.push("  [event] " + e.event);
  for (const u of captured.unsupported || []) lines.push("  [unsupported] " + u);
  for (const err of captured.errors || []) lines.push("  [error] " + err);
  if (!(captured.capabilities || []).length && !(captured.skillDirs || []).length) {
    lines.push("  (nothing registrable found - the bundle may need host services the bridge cannot stand in for)");
  }
  return lines.join("\n");
}

export default async function (pi) {
  /** True when a live DSH session is listening; then plugins are forwarded, not translated. */
  async function liveDshAvailable() {
    try {
      const h = await dshHostStatus();
      return !!(h && h.ok && h.serve);
    } catch {
      return false;
    }
  }

  /**
   * Install a DSH bundle by keeping it inside DSH. The bundle loads in the live
   * DSH session (its ctx.tools, ctx.llm and skills are the real host's), pi gets
   * one forwarding tool per capability, and every call returns DSH's own result.
   */
  /** Tool names this session registered, tracked here because ExtensionAPI exposes no registry. */
  const registeredTools = new Set()

  async function installDshViaHost(spec, opts) {
    const prefix = (opts && opts.prefix) || shortPrefix(spec.split(/[\\/]/).pop() || "dsh");
    const loaded = await dshHostLoad(spec);
    if (!loaded || !loaded.ok) throw new Error((loaded && loaded.error) || "the DSH host refused to load " + spec);
    const report = { tools: [], commands: [], skills: [], events: [], skipped: [] };
    for (const t of loaded.tools || []) {
      const name = prefix + "_" + t.name;
      if (registeredTools.has(name)) continue;
      try {
        pi.registerTool({
          name,
          label: t.name,
          description: (t.description || "(no description)") + " [dsh-pi-bridge: runs natively inside DSH from " + (loaded.name || "dsh") + "]",
          promptSnippet: t.description ? String(t.description).slice(0, 120) : undefined,
          parameters: dshParamsToSchema(t.parameters),
          async execute(_id, params) {
            const res = await dshHostCall(t.name, params || {});
            if (!res || !res.ok) {
              return { content: [{ type: "text", text: "DSH tool " + t.name + " failed: " + ((res && res.error) || "no result from DSH") }], details: { error: true, viaDsh: true } };
            }
            // DSH's defineTool contract returns { ok, result }; unwrap it.
            const payload = res.result && typeof res.result === "object" && res.result.result !== undefined ? res.result : { result: res.result };
            const text = typeof payload.result === "string" ? payload.result : JSON.stringify(payload.result ?? payload);
            return { content: [{ type: "text", text: (payload.ok === false ? "error: " : "") + text }], details: { viaDsh: true, tool: t.name } };
          },
        });
        registeredTools.add(name);
        report.tools.push(name);
      } catch (err) {
        report.skipped.push("tool " + name + ": " + message(err));
      }
    }
    for (const c of loaded.commands || []) report.commands.push(c.name);
    return { spec, loaded, report, prefix, mode: "dsh-host" };
  }

  async function installDsh(spec, opts) {
    if (await liveDshAvailable()) {
      const viaHost = await installDshViaHost(spec, opts);
      const state = await readState();
      state.bridges = state.bridges || {};
      state.bridges[spec] = {
        name: (viaHost.loaded && viaHost.loaded.name) || spec,
        version: String((viaHost.loaded && viaHost.loaded.version) || "0"),
        host: "dsh", prefix: viaHost.prefix, mirror: "", report: viaHost.report, mode: viaHost.mode,
        at: new Date().toISOString(),
      };
      await writeState(state);
      return formatReport(spec + " (via live DSH)", { info: { name: (viaHost.loaded && viaHost.loaded.name) || spec, version: (viaHost.loaded && viaHost.loaded.version) || "" } }, viaHost.report);
    }
    const captured = await loadForeign(spec, { host: "dsh", refresh: !!(opts && opts.refresh) });
    const prefix = (opts && opts.prefix) || shortPrefix(captured.info.name);
    const report = replayIntoPi(pi, captured, { prefix });
    const state = await readState();
    state.bridges = state.bridges || {};
    state.bridges[spec] = {
      name: captured.info.name,
      version: captured.info.version,
      host: "dsh",
      prefix,
      mirror: captured.mirror,
      report,
      at: new Date().toISOString(),
    };
    await writeState(state);
    return formatReport(spec, captured, report);
  }

  function firstArg(args) {
    return String(args || "").trim().split(/\s+/)[0];
  }

  pi.registerCommand("dsh-install", {
    description: "Install a DeepSeek Harness (DSH) plugin bundle into this pi session as tools, commands and skills",
    handler: async (args, ctx) => {
      const spec = firstArg(args);
      if (!spec) return notify(ctx, "usage: /dsh-install <npm:pkg | github:owner/repo | url | local path>", "error");
      notify(ctx, "bridging " + spec + " ...", "info");
      try {
        notify(ctx, await installDsh(spec), "info");
      } catch (e) {
        notify(ctx, "dsh-install failed: " + message(e), "error");
      }
    },
  });

  pi.registerCommand("dsh-preview", {
    description: "Inspect what a DSH plugin bundle would contribute before installing it",
    handler: async (args, ctx) => {
      const spec = firstArg(args);
      if (!spec) return notify(ctx, "usage: /dsh-preview <source>", "error");
      try {
        notify(ctx, await previewText(await loadForeign(spec, { host: "dsh" })), "info");
      } catch (e) {
        notify(ctx, "dsh-preview failed: " + message(e), "error");
      }
    },
  });

  pi.registerCommand("bridge-list", {
    description: "List plugin bundles this bridge installed into pi",
    handler: async (_args, ctx) => {
      const state = await readState();
      const keys = Object.keys(state.bridges || {});
      if (!keys.length) return notify(ctx, "no bridged bundles yet", "info");
      notify(ctx, keys.map((k) => {
        const b = state.bridges[k];
        return "- " + k + " (" + b.name + "@" + b.version + ") tools=" + (b.report.tools || []).join(",");
      }).join("\n"), "info");
    },
  });

  pi.registerCommand("bridge-remove", {
    description: "Forget a bridged bundle and delete its mirror build",
    handler: async (args, ctx) => {
      const spec = firstArg(args);
      const state = await readState();
      if (!spec || !state.bridges || !state.bridges[spec]) {
        return notify(ctx, "not bridged: " + (spec || "(no source given)"), "error");
      }
      const entry = state.bridges[spec];
      delete state.bridges[spec];
      await writeState(state);
      const { rm } = await import("node:fs/promises");
      if (entry.mirror) await rm(entry.mirror, { recursive: true, force: true });
      notify(ctx, "removed " + spec + " (tools registered earlier stay until pi restarts)", "info");
    },
  });

  // Model-callable mirrors, so an agent can install a DSH bundle unattended.
  pi.registerTool({
    name: "dsh_install",
    label: "Install DSH plugin",
    description: "Install a DeepSeek Harness plugin bundle into this pi session as native pi tools, slash commands and skills. Accepts the same source grammar pi uses: npm:<pkg>[@ver], git:github.com/<owner>/<repo>[@ref], github:<owner>/<repo>, a URL, or a local path.",
    promptSnippet: "Install a DSH plugin bundle as pi tools and commands",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Bundle source string." },
        prefix: { type: "string", description: "Optional lowercase prefix for bridged names." },
        refresh: { type: "boolean", description: "Re-download even when already cached." },
      },
      required: ["source"],
    },
    async execute(_id, params) {
      try {
        return { content: [{ type: "text", text: await installDsh(params.source, params) }], details: { bridge: "dsh-install" } };
      } catch (e) {
        return { content: [{ type: "text", text: "dsh_install failed: " + message(e) }], details: { error: true } };
      }
    },
  });

  // Replay recorded DSH bundles so /dsh-install survives a pi restart.
  const state = await readState();
  const restore = await restoreIntoPi(pi, state, { log: (m) => console.log(m) });
  if (restore.failed.length) console.log("dsh-pi-bridge restore skipped: " + restore.failed.join("; "));

  pi.registerTool({
    name: "dsh_preview",
    label: "Preview DSH plugin",
    description: "Inspect what a DeepSeek Harness plugin bundle would contribute to this pi session before installing it.",
    promptSnippet: "Preview a DSH bundle's tools, commands and skills",
    parameters: {
      type: "object",
      properties: { source: { type: "string", description: "Bundle source string." } },
      required: ["source"],
    },
    async execute(_id, params) {
      try {
        return { content: [{ type: "text", text: await previewText(await loadForeign(params.source, { host: "dsh" })) }], details: { bridge: "dsh-preview" } };
      } catch (e) {
        return { content: [{ type: "text", text: "dsh_preview failed: " + message(e) }], details: { error: true } };
      }
    },
  });
}

function notify(ctx, text, level) {
  try {
    if (ctx && ctx.ui && typeof ctx.ui.notify === "function") return ctx.ui.notify(text, level || "info");
  } catch {
    /* fall through to stdout */
  }
  console.log(text);
}

function message(e) {
  return e && e.message ? String(e.message).slice(0, 400) : String(e);
}
