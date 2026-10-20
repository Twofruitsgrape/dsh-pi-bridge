[English](../../README.md) · **മലയാളം**

# dsh-pi-bridge

ഒരു പ്ലഗിൻ, രണ്ട് ഹോസ്റ്റുകൾ. pi-യിൽ ഇൻസ്റ്റാൾ ചെയ്താൽ pi-ന് DeepSeek Harness പ്ലഗിനുകൾ ചെയ്യാൻ കഴിയും; DSH-യിൽ ഇൻസ്റ്റാൾ ചെയ്താൽ DSH-ന് pi പ്ലഗിനുകൾ ചെയ്യാൻ കഴിയും. മറ്റേ ഭാഗത്തിന്റെ കോഡ് ആരും "തർജ്ജമ" ചെയ്യുന്നില്ല: പ്ലഗിൻ എപ്പോഴും അതിന്റെ സ്വന്തം ഹോസ്റ്റിൽ — ഹോസ്റ്റ് API യഥാർത്ഥമായിരിക്കുന്നിടത്ത് — പ്രവർത്തിക്കുന്നു, മറ്റേ ഭാഗം വിളിക്കൾ മാത്രം കൈമാറുന്നു.

```text
# pi
pi install npm:dsh-pi-bridge            # അല്ലെങ്കിൽ: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

ഇൻസ്റ്റാളിന് ശേഷം ഹോസ്റ്റ് വീണ്ടും തുടങ്ങുക. രണ്ട് കീവേഡുകളും (`pi-package`, `dsh-plugin`) പ്രഖ്യാപിച്ചിട്ടുണ്ട്, അതിനാൽ ഓരോ ഇക്കോസിസ്റ്റത്തിലെയും മാർക്കറ്റ്പ്ലേസ് ഈ പാക്കേജ് കണ്ടെത്തും.

## ഓരോ ഹോസ്റ്റിലും എന്ത് ലഭിക്കും

| | pi | DSH |
|---|---|---|
| മറ്റേ വശത്ത് പ്ലഗിനുകൾ | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| ലോഗ് ചെയ്ത എന്തിനും നിയന്ത്രണം | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| skill | `skills/dsh-pi-bridge/SKILL.md` | അതേ `SKILL.md`, skill registry വഴി ലോഡ് ചെയ്യുന്നു |

സ്രോതസ്സുകൾക്ക് രണ്ട് ഭാഗങ്ങളും ഒരേ ഡയലക്റ്റ് സംസാരിക്കുന്നു: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, റിപ്പോ യൂണിയൻ അല്ലെങ്കിൽ ലോക്കൽ പാത — ഓരോ ഹോസ്റ്റും ആദ്യം സ്വീകരിക്കുന്ന രൂപങ്ങൾ തന്നെ.

ഒരു യഥാർത്ഥ സെഷനിൽനിന്നുള്ള ഒരു ഭാഗം, വാക്കോരോ: യഥാർത്ഥ DSH തുടക്കം, യഥാർത്ഥ മോഡൽ, പ്രസിദ്ധീകരിച്ച ഒരു pi പാക്കേജ് ഇൻസ്റ്റാൾ ചെയ്യുന്നു.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # pi പാക്കേജിൽനിന്നുള്ള ഒരു ടൂൾ
  -> ജീവനുള്ള തിരയൽ ഫലങ്ങൾ, പാക്കേജിന്റെ provider തന്നെ കൊണ്ടുവരുന്നത്, അതിന്റെ config ഉപയോഗിച്ച്
```

## എങ്ങനെ പ്രവർത്തിക്കുന്നു

### DSH-യിലേക്ക് വരുന്ന pi പ്ലഗിനുകൾ: നിരീക്ഷണം ചെയ്യുന്ന pi പ്രോസസ്

`pi_install` പാക്കേജ് ബ്രിഡ്ജ് cache-ൽ "ഇൻസ്റ്റാന്റിയേറ്റ്" ചെയ്യുന്നു, അതിന്റെ യഥാർത്ഥ dependencies ഇൻസ്റ്റാൾ ചെയ്യുന്നു, പിന്നെ ബ്രിഡ്ജ് നിരീക്ഷിക്കുന്ന ഒരു pi പ്രോസസിലേക്ക് (`pi --mode rpc`) ലോഡ് ചെയ്യുന്നു. pi റിപ്പോർട്ട് ചെയ്യുന്ന ഓരോ binding ഉം DSH-യിൽ ഒരു ടൂൾ ആകുന്നു; കോളുകൾ pi-യിലേക്ക് കൈമാറുന്നു, pi നിർമ്മിക്കുന്ന ഫലം തിരികെ വരുന്നു. `SKILL.md` ഫോൾഡർ ഡാറ്റ ആയി `ctx.skills` വഴി ലോഡ് ചെയ്യുന്നു. പാക്കേജിന് കാണുന്നത്: ബ്രിഡ്ജിൽനിന്നുള്ള യഥാർത്ഥ `registerTool`, ബ്രിഡ്ജിൽനിന്നുള്ള `registerProvider`, pattern സ്ട്രീം, provider ക്രെഡൻഷ്യലുകൾ — നെറ്റ്വർക്കും മോഡലും സ്പർശിക്കുന്ന പാക്കേജ് pi ഉപയോക്താവിന്റെ കൈയിലുള്ളതുപോലെ തന്നെ പ്രവർത്തിക്കും.

ഈ രൂപകൽപ്പന മുൻ സമീപനത്തെ — DSH-യിൽ റീജിസ്റ്റ്രേഷനുകൾ വീണ്ടും നിർമ്മിച്ച് stub ഉള്ള imports-നെ ആശ്രയിച്ചത് — മാറ്റിസ്ഥാപിക്കുന്നു. ആ പതിപ്പ് എല്ലാ മാതൃക ടെസ്റ്റുകളും പാസാക്കി യഥാർത്ഥ പാക്കേജുകളിൽ വീണു — stub കഴിച്ച import പ്രവർത്തിക്കാത്ത ടൂൽ ആണല്ലോ. കോളുകൾ സ്വന്തം ഹോസ്റ്റിലേക്ക് കൈമാറുന്നത് ഫലങ്ങളെ സംബന്ധിച്ച് സത്യസന്ധമായി തുടരാനുള്ള ഒരേ രൂപമാണ്.

### pi-യിലേക്ക് വരുന്ന DSH പ്ലഗിനുകൾ: ജീവനുള്ള DSH സെഷൻ

Bundle ചെയ്ത DSH പാക്കേജിന് യഥാർത്ഥ `ctx.tools`, `ctx.llm`, skill registry വേണം; അതുകൊണ്ട് `dsh_install` ജീവനുള്ള DSH സെഷനോട് പാക്കേജ് സ്വയം ലോഡ് ചെയ്യാൻ പറയുന്നു. തടസ്സം അവിടെയാണ്: പ്ലഗിൻ മാനേജർ ഇൻസ്റ്റാൾ ചെയ്ത പാക്കേജ് പ്രൊഫൈലിന്റെ `node_modules`-ന് കീഴിലെ ഒരു symlink ആണ്, ആദ്യം `@deepseek-ai/*` പോലുള്ള bare specifiers റെസോൾവ് ആകില്ല — പരിശോധന `MODULE_NOT_FOUND` റിപ്പോർട്ട് ചെയ്തു. ഇതാണ് `src/dsh-loader.js` ചെയ്യുന്നത്: ഈ specifiers-നെ ഓടുന്ന build കൈയിലുള്ള മോഡ്യൂളുകളുടെ URL വിലാസങ്ങളാക്കി മാറ്റുന്നു (യഥാർത്ഥ പാക്കേജുകൾ, stub അല്ല) — relative imports, `node:`, third-party imports സ്വയം നിൽക്കുന്നു. പാക്കേജ് ഹോസ്റ്റിന് മുന്നിൽ രജിസ്റ്റർ ആകുന്നു, pi-ന് ഓരോ കഴിവിനും ഒരു ഫോർവേഡഡ് ടൂൾ കിട്ടുന്നു.

Endpoint default ആയത് bundle ആണ്; സാധാരണ DSH തുടക്കം ഒരു പോർട്ടും തുറക്കുന്നില്ല:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # DSH വശം
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # pi വശം
```

127.0.0.1-ൽ മാത്രം കേൾക്കുന്നു, client ലൂപ്പ്ബാക്ക് അല്ലാത്ത വിലാസങ്ങൾ നിരസിക്കുന്നു. ജീവനുള്ള DSH സെഷൻ സാധ്യമല്ലാത്തപ്പോൾ `dsh_install` അത് നേരിട്ട് പറയുകയും തർജ്ജമ മോഡിലേക്ക് മടങ്ങുകയും ചെയ്യുന്നു, കൈമാറൽ വിജയിച്ചു എന്ന് കരുതുന്നതിനു പകരം.

### ഒരു ഹോസ്റ്റും ലഭ്യമല്ലാത്തപ്പോൾ

ബ്രിഡ്ജ് സ്രോതസ്സ് റെസോൾവ് ചെയ്യുന്നത് തുടരുന്നു, TypeScript transpile ചെയ്യുന്നു (`node:module`-യിലെ `stripTypeScriptTypes`, toolchain download ഇല്ലാതെ), പാക്കേജ് എന്ത് രജിസ്റ്റർ ചെയ്യുമെന്ന് ക്യാപ്ചർ ചെയ്യുന്നു — അതിനാൽ `preview` എവിടെയും പ്രവർത്തിക്കും. റീജിസ്ട്രേഷനുകൾ മറ്റേ ഹോസ്റ്റിലേക്ക് റീപ്ലേ ചെയ്യല് same-host scenario-യും payload പൂർണ്ണമായി നൽകിയ പാക്കേജുകളും മാത്രമേ കരുതിവച്ചിട്ടുള്ളൂ — skill ഫോൾഡർ മാത്രമുള്ള ഒരു DSH bundle-ൽ കോൾ ചെയ്യാവുന്നതൊന്നുമില്ല, പക്ഷേ skill അതേ കടന്നുപോകും. രണ്ട് ഹോസ്റ്റുകളും [Agent Skills സ്പെസിഫിക്കേഷൻ](https://agentskills.io/specification) പിന്തുടരുന്നു.

### പാരാമീറ്ററുകളുടെയും ഫലങ്ങളുടെയും രൂപം

DSH ടൂളുകൾ property-descriptor ടേബിൾ കൊണ്ടുനടക്കുന്നു (`{ text: { type: "string", required: true } }`), അത് `@deepseek-ai/dsh-tools` JSON Schema ആക്കി മാറ്റുന്നു; pi ടൂളുകൾ JSON Schema നേരിട്ടെടുക്കുന്നു (TypeBox). `src/schema.js` രണ്ട് വശങ്ങളിലും മാറ്റുന്നു, ഫലങ്ങൾക്കും അതേ mapping വരുന്നു: pi-യിലെ `{ content: [{ type: "text" }] }`-ഉം DSH-യിലെ `{ ok, result }`-ഉം തമ്മിൽ മാറ്റം നടക്കുന്നു. ഹോസ്റ്റ് രജിസ്റ്റർ ചെയ്യുമ്പോൾ schema സാധുതാ പരിശോധിക്കുന്നു, അത് സ്വീകരിക്കുന്ന subset JSON Schema draft-നേക്കാൾ ഇടുങ്ങിയതാണ് — result schema-യിലെ property-node തലത്തിലെ `required` ഫ്ലാഗ്, അല്ലെങ്കിൽ object-level `required` അറേ, മുഴുവൻ പ്ലഗിന്റെ ലോഡിങ് പോലും വീഴ്ത്തിയേക്കും. ഇവ ഇൻസ്റ്റാൾ ചെയ്ത ഹോസ്റ്റുകളിൽ പരിശോധിച്ച് കണ്ടെത്തിയ നിയമങ്ങളാണ്, test suite-ൽ static അവകാശവാദങ്ങളായി അടക്കിവച്ചിട്ടുണ്ട്.

## പരിശോധിച്ചത് — എങ്ങനെ

ചുവടെയുള്ള ഓരോ വരിയും യഥാർത്ഥ ഹോസ്റ്റിനെതിരെ പരിശോധിച്ചവയാണ്, stubs-നെതിരെയല്ല:

- യഥാർത്ഥ DSH സ്റ്റാർട്ടപ്പ്, യഥാർത്ഥ മോഡൽ, `npm:pi-web-access` ഇൻസ്റ്റാൾ ചെയ്ത് അതിലൂടെ `web_web_search` വിളിച്ചു
- യഥാർത്ഥ DSH സെഷൻ `@deepseek-ai/dsh-tools` പോലുള്ള bare import ഉള്ള പാക്കേജ് ലോഡ് ചെയ്തു; പിന്നെ ഒരു പ്രത്യേക പ്രോസസ് loopback വഴി അതിന്റെ ടൂളുകൾ വിളിച്ചു
- ബ്രിഡ്ജിന്റെ DSH എൻട്രി അതേ സംവിധാനം ഉപയോഗിച്ച് pi-യിലെ അന്യ പാക്കേജെന്നോണം പ്രവർത്തിച്ചു

ഓരോന്നും ഒരു stub പിടിക്കാത്ത ഒരു ബഗ് പിടിച്ചു: പ്രസിദ്ധീകരിച്ച tarball-ൽ ഒരു ഫയൽ വിട്ടുപോയിരുന്നു; ഹോസ്റ്റ് തള്ളിക്കളയുന്ന ഒരു output schema പ്ലഗിനെ ശബ്ദമില്ലാതെ മരണപ്പെടുത്തി; host process-ൽ `process.execPath` host binary ആണ്, node അല്ല; re-install സമയത്ത് പൂജ്യം capabilities റിപ്പോർട്ട് ആയി, കാരണം daemon പാക്കേജ് ഇതിനകം ലോഡ് ചെയ്തിരുന്നു; property-യിലേക്കുള്ള assignment നിരോധിക്കുന്ന ഒരു scope; binder fiber എന്നതിന് പുറത്തുള്ള ഒരു server handler; duplicate ടൂൾ നാമങ്ങൾ റിജക്ട് ചെയ്യുന്ന ഒരു ഹോസ്റ്റ്.

```bash
npm test                # എല്ലാ test suites-ഉം നെറ്റ്വർക്ക് ഇല്ലാതെ
npm run test:offline    # പൈപ്പ്ലൈൻ + രണ്ട് വശത്തുനിന്നുമുള്ള host input
npm run test:proxy      # daemon, DSH വശവും pi വശവും
npm run test:host       # ഇൻസ്റ്റാൾ ആക്കിയ DSH build-നെതിരെ (കുറിപ്പ് കാണുക)
npm run test:network    # npm ഉം GitHub-ഉം നിന്നുള്ള യഥാർത്ഥ പ്രസിദ്ധീകൃത പാക്കേജുകൾ
npm run test:live       # ഒരു യഥാർത്ഥ ഓടുന്ന pi-യിലേക്ക് ഏഴ് ടെസ്റ്റുകളും
```

`test:host` ഒരു ഇൻസ്റ്റാൾ ആക്കിയ ഹോസ്റ്റിന്റെ asar-ക്കു നടുവിൽനിന്ന് വായിക്കുന്നു — ഹോസ്റ്റിന്റെ സ്വന്തം `@deepseek-ai/dsh-tools` — Electron patched fs-ഉം മാത്രമേ അത് സാധ്യമാക്കൂ; ആയതിനാൽ അത് host process-ക്കു നടുവിൽ തന്നെ ഓട്ടുക. സാധാരണ node-ൽ അത് വ്യക്തമായി SKIP റിപ്പോർട്ട് ചെയ്യും, ഹോസ്റ്റ് ഒന്നും മേൽ നിരസിച്ചു എന്നൊരു സൂചന ഇല്ലാതെ.

## കടന്നുപോകാത്തവ

ബ്രിഡ്ജ് ഇവ നേരിട്ട് പറയുന്നു:

- **host UI**: DSH ബ്രൗസർ പേജുകൾ / `ctx.slots`; pi TUI UI മിനുക്കുപ്പ്, `ctx.ui`, ചൂടുകീകൾ, CLI flags.
- **ഹോസ്റ്റിൽ രജിസ്റ്റർ ചെയ്ത model adapters**: ആര് provider ചേർത്താലും അവരുടെ സ്വന്തം ഹോസ്റ്റിലേക്ക് ചേർക്കും — ഇതാണ് "തർജ്ജമ ഇല്ല" എന്നതിന്റെ അർത്ഥം — pi providers pi-യിലേക്ക്, DSH adapters DSH-യിലേക്ക്.
- **call-able ഒന്നുമില്ലാത്ത DSH bundles**: pure-UI അല്ലെങ്കിൽ pure-settings overlay-ക്ക് bridged ടൂളുകൾ ഇല്ല. preview ഇത് വ്യക്തമായി പറയും, capability-യുടെ പേരിൽ നുണ പറയാതെ.
- **interactive host ആവശ്യപ്പെടുന്ന പാക്കേജുകൾ**: കൈമാറിയ കോൾ progress ജീവനുള്ള പോലെ ഓടാം, പക്ഷേ മറുവശത്ത് ഒരു picker തുറക്കാൻ കഴിയില്ല.

## സ്ഥിരത

രജിസ്റ്റ്രേഷനുകൾ ഉടനെ സെഷനിൽ കയറുന്നു. ഓരോ host-ഉം, plugin load സമയത്ത്, `~/.dsh-pi-bridge/bridges.json`-ൽനിന്ന് തന്റേത് വീണ്ടും വായിക്കുന്നു; അതായത് install ഒരു restart-നും അതിജീവിക്കുന്നു — DSH സെഷൻ restart ചെയ്ത് bridge tools സ്ഥലത്ത് കണ്ട് പരീക്ഷിച്ചു. പുനരെടുപ്പ് cache മാത്രം വായിക്കുന്നു: host തുടക്കം network download കാത്തിരിക്കില്ല; cache വൃത്തിയാക്കിയാൽ ബ്രിഡ്ജ് "കൈവശമില്ല" എന്ന് റിപ്പോർട്ട് ചെയ്യും, ഉറങ്ങില്ല. Restart മറ്റ് ക്ലയന്റുകളെ (web GUI, രണ്ടാം ജനൽ) പുതിയ ടൂളുകൾ കാണാനും വിട്ടുകൊടുക്കുന്നു, കാരണം അവ തുടക്കത്തിൽ ടൂൾ ലിസ്റ്റ് നിർമ്മിക്കുന്നു. Bundle-ന്റെ config-ൽ `restoreOnLoad: false` വച്ച് ഇത് ഓഫ് ചെയ്യാം.

host settings-ൽ ഒന്നും എഴുതുന്നില്ല. `bridge_remove` bridge മറക്കുകയും അതിന്റെ build-ൽ dir നശിപ്പിക്കുകയും ചെയ്യുന്നു; ജീവനുള്ള process-ൽ രജിസ്റ്റർ ആയ ടൂളുകൾ restart വരെ നിൽക്കുന്നു, കാരണം നിശ്ശബ്ദ deregister host-നു കൂടുതൽ മോശം.

## സുരക്ഷ

ബ്രിഡ്ജ് ചെയ്ത പാക്കേജ് **നിങ്ങളുടെ അനുമതികളോടെ, നിങ്ങൾ ഓടിക്കുന്ന host-ൽ കോഡ് ഓടിക്കുന്നു.** ഓരോ plugin host-ഉം ഇതേ claim ഉണ്ടാക്കുന്നു; ഈ പാക്കേജ് മറ്റൊരു ഇക്കോസിസ്റ്റത്തിൽനിന്നാണ് വരുന്നത്, അതിന്റെ marketplace review കടന്നിട്ടില്ല, അതിനാൽ claim കൂടുതൽ മൂർച്ചയുള്ളതാണ്. ആദ്യം അതിന്റെ കോഡ് വായിക്കുക; `preview` വിശകലനവും പരിശോധനയും മാത്രം, ഒന്നും register ചെയ്യില്ല.

കൈമാറിയ കോൾ sandbox അല്ല: പാക്കേജ് അതിന്റെ host-ന്റെ മുഴുവൻ വിശ്വാസത്തോടെയും ഓടുന്നു — അതാണ് ഇത് പ്രവർത്തിക്കാൻ കഴിയുന്നതിന്റെ കാരണം. Loopback സർവീസ് 127.0.0.1-ൽ മാത്രം bind ചെയ്യുന്നു; `DSH_PI_BRIDGE_DSH_SERVE` set ചെയ്തിട്ടുണ്ടെങ്കിൽ മാത്രമേ തുറക്കൂ; client loopback അല്ലാത്ത വിലാസങ്ങൾ നിരസിക്കുന്നു. പോർട്ട് എത്തിപ്പിടിക്കാൻ കഴിയുന്ന ആർക്കും സെഷൻ ലോഡ് ചെയ്ത ഏത് ടൂളും വിളിക്കാം. വേണ്ടിവരിക്കയില്ലെങ്കിൽ തുറക്കരുത്.

## ക്രമീകരണം

```text
index.js                DSH എൻട്രി: name / inject / apply(ctx), അതായത് pi_* ടൂളുകൾ
extensions/index.js     pi എൻട്രി: default(pi) ഫാക്ടറി, dsh_* ടൂളുകളും കമാൻഡുകളും
skills/dsh-pi-bridge/   SKILL.md, രണ്ട് hosts കൂടി ഉപയോഗിക്കുന്നു
cordis.patch.yml        DSH bundle മൗണ്ട് (configuration key അനുസരിച്ച്)
daemon/run.mjs          supervised pi process; അതിന്റെ ടൂളുകൾ loopback പക്ഷം വഹിക്കുന്നു
daemon/bootstrap.js     pi plugin loader ഉപയോഗിച്ച്, യഥാർത്ഥ pi plugins ഉപയോഗിച്ച് തന്നെ ലോഡ്
src/proxy.js            DSH വശം: spawn/reuse daemon, per-call forwarding
src/dsh-loader.js       DSH വശം: runtime ൽ bundle ലോഡ്, ജീവനുള്ള scope-നെതിരെ
src/serve.js            DSH വശം: loopback endpoint മറ്റേ host-ന്
src/dsh-host-client.js  pi വശം: ജീവനുള്ള DSH സെഷനുമായി സംസാരിക്കുന്നു
src/resolve.js          npm / git / url / local സ്രോതസ്സുകൾ cache-ലേക്ക്, deps ഇൻസ്റ്റാൾ ചെയ്തു
src/load.js             mirrored tree നിർമ്മിക്കുന്നു, TS transpile, യഥാർത്ഥ deps ഇൻസ്റ്റാൾ
src/manifest.js         keywords, manifest, ഫോൾഡർ ഘടന — host കണ്ടെത്തുന്നത്
src/capture.js          രജിസ്റ്റർ ചെയ്ത stub hosts, രണ്ട് entry പതിവുകൾക്കും
src/schema.js           പാരാമീറ്റർ schemas-ന്റെ ഇരുവശത്തുമായ മാറ്റം
src/capabilities.js    standardized capability model; ഫലങ്ങൾ mapping
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          host init സമയത്ത് രജിസ്റ്റർ ആയ bridges വീണ്ടും പുനരെടുക്കുന്നു
src/stubs.js            import പരിശോധന, preview-ന് stub നിർമ്മാണം
src/tar.js              gzipped-tar reader, deps ഇല്ലാതെ
src/transpile.js        TypeScript -> ESM, node:module വഴി
```

`index.js` `node:` builtins മാത്രം — പാക്കേജ് തന്നെയടക്കം — import ചെയ്യുന്നു, `inject: ["tools"]` പ്രഖ്യാപിക്കുന്നു — ആവശ്യമുള്ള ഒരേ ഒരു service. Skills-ഉം settings-ഉം capability check-ന് ശേഷം `ctx.inject` വഴിയാണ് എത്തുന്നത്; skill registry ഇല്ലാത്ത profile skill mount ചെയ്യില്ല മാത്രമേ, startup fail ആവില്ല.

## ലൈസൻസ്

MIT
