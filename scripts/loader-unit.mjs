// Unit checks for the runtime DSH bundle loader: specifier classification and
// host rewriting. They need no host, so they can gate the publish path.
import { isHostSpecifier, rewriteHostSpecifiers, hostModulesRoots } from "../src/dsh-loader.js"

let fails = 0
const check = (label, ok, detail) => {
  if (ok) console.log("  ok   " + label)
  else { fails++; console.log("  FAIL " + label + (detail ? " :: " + detail : "")) }
}

check("classifies @deepseek-ai/* as host", isHostSpecifier("@deepseek-ai/dsh-tools"))
check("classifies cordis as host", isHostSpecifier("cordis"))
check("classifies @deepseek-ai/schemastery as host", isHostSpecifier("@deepseek-ai/schemastery"))
check("leaves a third-party package alone", !isHostSpecifier("picocolors"))
check("leaves node: alone", !isHostSpecifier("node:fs"))
check("leaves relative alone", !isHostSpecifier("./x.js"))

const SRC = [
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  "import { z } from '@deepseek-ai/schemastery'",
  "import rel from './rel.js'",
  "import fs from 'node:fs'",
  "import pc from 'picocolors'",
  "const lazy = () => import('@deepseek-ai/dsh-llm')",
].join(String.fromCharCode(10))

const fake = (s) => (s === "@deepseek-ai/dsh-tools" || s === "@deepseek-ai/dsh-llm" ? "C:/host/mod.js" : null)
const { code, mapped } = rewriteHostSpecifiers(SRC, fake)

check("rewrote the resolvable host import", code.includes("file:///C:/host/mod.js"), code.slice(0, 140))
check("reported what it mapped", mapped.length === 2 && mapped[0].specifier === "@deepseek-ai/dsh-tools", JSON.stringify(mapped))
check("left the unresolvable host import alone", code.includes("'@deepseek-ai/schemastery'"), code.slice(0, 200))
check("kept the relative specifier", code.includes("'./rel.js'"))
check("kept the node: specifier", code.includes("'node:fs'"))
check("kept the third-party specifier", code.includes("'picocolors'"))
const hits = code.split("file:///C:/host/mod.js").length - 1
check("rewrote the dynamic import as well", hits === 2, "hits=" + hits + " tail=" + code.slice(-90))

const roots = hostModulesRoots("C:/App/DeepSeek Harness.exe")
check("derives two roots from execPath", roots.length === 2 && roots[0].includes("app.asar") && roots[1].includes("asar.unpacked"), JSON.stringify(roots))

console.log("")
console.log(fails ? "LOADER UNIT FAILED (" + fails + ")" : "LOADER UNIT PASSED")
process.exitCode = fails ? 1 : 0
