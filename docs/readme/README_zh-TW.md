[English](../../README.md) · **繁體中文**

# dsh-pi-bridge

一個外掛，兩個宿主。裝進 pi，pi 就能使用 DeepSeek Harness 外掛；裝進 DSH，DSH 就能使用 pi 外掛。任何一側都不靠翻譯對方的程式碼來執行外掛：外掛始終在它自己的宿主內執行——那裡的宿主 API 是真實的——另一側只負責呼叫。

```text
# pi
pi install npm:dsh-pi-bridge            # 或者: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

安裝後重新啟動宿主。兩個關鍵字（`pi-package` 與 `dsh-plugin`）均已宣告，所以各自生態的市集都能搜到這個套件。

## 每個宿主裡你能得到什麼

| | pi | DSH |
|---|---|---|
| 使用另一側的外掛 | `dsh_install`、`dsh_preview`、`/dsh-install`、`/dsh-preview` | `pi_install`、`pi_preview` |
| 管理已橋接的內容 | `/bridge-list`、`/bridge-remove` | `bridge_list`、`bridge_remove`、`bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | 同一個 `SKILL.md`，經 skill 註冊表掛載 |

兩側使用同一套來源語法：`npm:<pkg>[@ver]`、`git:github.com/<owner>/<repo>[@ref]`、`github:<owner>/<repo>`、儲存庫 URL 或本地路徑——與各宿主本來接受的格式完全一致。

一段真實的會話記錄，原文照錄：真實 DSH 啟動、真實模型、安裝一個真實發佈的 pi 套件。

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # 一個來自 pi 套件的工具
  -> 即時搜尋結果，由套件自己用自己的 provider 設定擷取
```

## 工作原理

### pi 外掛進入 DSH：受監督的 pi 行程

`pi_install` 把套件實體化到橋的快取裡，安裝它真實的相依套件，然後在一個由橋監督的 pi 行程（`pi --mode rpc`）內載入它。pi 上報的每一個註冊項都會成為 DSH 的一個工具，呼叫時轉發給 pi 並回傳 pi 算出的結果。`SKILL.md` 目錄作為資料經 `ctx.skills` 掛載。套件看到的是 pi 真實的 `registerTool`、`registerProvider`、模型註冊表與 provider 憑證——一個要存取網路或模型的套件，行為和 pi 使用者手裡完全一樣。

這一設計取代了早期把註冊項重放到 DSH、依賴樁化 import 的方案。那個版本通過了所有 mock 測試，卻在真實套件面前潰敗——因為一個被樁化的相依就是一個跑不起來的工具。轉發進原生宿主，是唯一能對結果保持誠實的版本。

### DSH 外掛進入 pi：活著的 DSH 會話

一個 DSH bundle 需要的是真實的 `ctx.tools`、`ctx.llm` 與 skill 註冊表，所以 `dsh_install` 請求活著的 DSH 會話自己載入這個 bundle。障礙在於：外掛管理器裝好的 bundle 是 profile `node_modules` 下的一個 symlink，裸引 `@deepseek-ai/*` 無法解析——實測報 `MODULE_NOT_FOUND`。`src/dsh-loader.js` 恰好把這些說明符重寫為執行中 build 自帶模組的 URL（是真包，不是樁），相對匯入、`node:` 與第三方匯入則原樣保留。bundle 向宿主註冊，pi 收到每個能力對應的轉發工具。

端點預設關閉，普通 DSH 啟動不開任何連接埠：

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # DSH 側
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # pi 側
```

只綁定 127.0.0.1，用戶端拒絕非回環位址。沒有可達的活 DSH 時，`dsh_install` 會如實說明並退回翻譯模式，而不是假裝轉發成功。

### 兩個宿主都不可達時

橋仍然會解析來源、編譯 TypeScript（`node:module` 的 `stripTypeScriptTypes`，無需下載工具鏈）並捕捉套件會註冊什麼，所以 `preview` 在任何地方都能用。把註冊項重放到另一宿主保留給同宿主情境，以及整個載荷都是資料的 bundle——一個純 skill 目錄的 DSH bundle 沒有可呼叫的東西，skill 本身照樣能過去。兩個宿主都實作了 [Agent Skills 規範](https://agentskills.io/specification)。

### 參數與結果形態

DSH 工具攜帶屬性規格表（`{ text: { type: "string", required: true } }`），由 `@deepseek-ai/dsh-tools` 編譯成 JSON Schema；pi 工具直接攜帶 JSON Schema（TypeBox）。`src/schema.js` 雙向轉換，結果也做同樣的投影：pi 的 `{ content: [{ type: "text" }] }` 與 DSH 的 `{ ok, result }` 互轉。宿主在註冊時校驗 schema，且接受的子集比 draft JSON Schema 窄——屬性節點上的 `required` 標記，或輸出 schema 裡物件級的 `required` 陣列，會讓整個外掛無法啟用。這些規則來自對已安裝宿主的實測，測試套件中有對應斷言。

## 已驗證，以及驗證方式

以下每一條都對著真實宿主測過，不是對著 mock：

- 真實 DSH 啟動、真實模型，安裝 `npm:pi-web-access` 並透過它呼叫 `web_web_search`（結果由套件自己的 provider 擷取）
- 真實 DSH 會話載入一個裸引 `@deepseek-ai/dsh-tools` 的 bundle，然後經 loopback 提供給獨立行程呼叫它的工具
- pi 經由外來 bundle 會遇到的同一套機制執行本橋自己的 DSH 入口

其中每一條都抓到了一個 mock 抓不到的 bug：發佈清單裡漏掉的檔案、宿主拒絕導致外掛靜默失效的輸出 schema、宿主行程裡 `process.execPath` 指向應用而非 node、重裝時因守護行程已載入過套件而上報零能力、禁止屬性賦值的 scope、在啟動服務的 fiber 之外執行的 server handler、宿主拒絕重複工具名。

```bash
npm test                # 全部離線套件
npm run test:offline    # pipeline + 兩側宿主入口
npm run test:proxy      # daemon、DSH 側與 pi 側轉發
npm run test:host       # 對著已安裝的 DSH build（見說明）
npm run test:network    # 來自 npm 與 GitHub 的真實發佈套件
npm run test:live       # 上面的測試對著真正執行中的 pi
```

`test:host` 從已安裝宿主的 asar 內部讀取宿主自己的 `@deepseek-ai/dsh-tools`，只有帶 Electron 補丁的 fs 才能讀到；請在宿主行程裡執行它。普通 node 下它會明確回報 SKIP，而不是暗示宿主拒絕了我們。

離線套件手工搭建夾具——一個用 TypeBox builder 的 TypeScript pi 擴充、一個用 `defineTool` 的 DSH bundle、一個裸引宿主套件的 bundle——然後讓整條管線對著錄音替身執行，並真正執行橋接出來的工具。有些規則用靜態斷言，因為它們只在真實啟動時暴露：宿主接受的 schema 形態、必須發佈的檔案、分析 bundle 不得起行程不得綁連接埠。

## 不會跨宿主的內容

橋會如實回報這些情況，而不是悄悄失敗：

- **宿主 UI**：DSH 瀏覽器頁面 / `ctx.slots`，pi 的 TUI 渲染器、`ctx.ui`、快捷鍵、CLI 旗標。
- **註冊進宿主的模型配接器**：新增 provider 的套件是對自己的宿主做的——這正是「不翻譯」的意義所在——pi 的 provider 落進 pi，DSH 的 adapter 落進 DSH。
- **沒有任何可呼叫物的 DSH bundle**：純 UI 或純設定覆蓋層沒有可轉發的工具。preview 會如實說明，而不是編造能力。
- **需要互動式宿主的套件**：轉發呼叫可以串流上報進度，但無法在另一側彈出選擇器。

## 持久化

註冊項立即落在當前會話。每個宿主在外掛載入時從 `~/.dsh-pi-bridge/bridges.json` 重載自己記錄過的內容，所以安裝能挺過重新啟動——已透過重新啟動 DSH 會話並發現橋接工具已在場驗證。重載只讀快取：宿主啟動絕不等待網路下載，快取被清掉時橋會回報不可用而不是掛住。重新啟動也讓其他用戶端（Web GUI、第二個視窗）能看到新工具，因為它們在啟動時建構工具清單。bundle 設定裡 `restoreOnLoad: false` 可關閉。

不向任何宿主的設定裡寫東西。`bridge_remove` 忘記一個橋並清掉它的 build 目錄；已註冊進執行中行程的工具會留到重新啟動，因為靜默註銷宿主狀態比讓它繼續可見更糟。

## 安全

橋接的套件**以你的權限在它執行的那一側執行程式碼**——每個擴充宿主都有同樣的要求，而這個套件來自另一個生態、未經其市集審查，所以要求更高。先讀它的原始碼；`preview` 只解析與檢視，不註冊任何東西。

轉發不做沙箱：套件帶著自己宿主的全部信任執行，這正是它能工作的原因。loopback 端點只綁定 127.0.0.1，除非設定 `DSH_PI_BRIDGE_DSH_SERVE` 否則不開啟，用戶端拒絕非回環位址。任何能連上該連接埠的人都能呼叫會話已載入的工具，所以不需要就別開。

## 目錄結構

```text
index.js                DSH 入口：name / inject / apply(ctx)，即 pi_* 工具
extensions/index.js     pi 入口：default(pi) 工廠，dsh_* 工具與命令
skills/dsh-pi-bridge/   SKILL.md，兩側宿主共用
cordis.patch.yml        DSH bundle 掛載（外掛面板的開關目標）
daemon/run.mjs          受監督的 pi 行程；其工具的 loopback 前端
daemon/bootstrap.js     由 pi 真實的外掛載入器載入 pi 內部
src/proxy.js            DSH 側：啟動/複用 daemon，轉發呼叫
src/dsh-loader.js       DSH 側：對著活 scope 在執行時載入 bundle
src/serve.js            DSH 側：給另一個宿主用的 loopback 端點
src/dsh-host-client.js  pi 側：與活 DSH 會話通訊
src/resolve.js          npm / git / url / 本地來源進快取，帶相依安裝
src/load.js             建構鏡像樹、編譯 TS、安裝真實相依
src/manifest.js         從關鍵字、清單與目錄形態做宿主識別
src/capture.js          兩種入口約定的錄音替身宿主
src/schema.js           參數 schema 雙向轉換
src/capabilities.js     正規化的能力模型，結果投影
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          宿主啟動時重載已記錄的橋
src/stubs.js            preview 用的 import 掃描與樁生成
src/tar.js              gzipped-tar 讀取器，零相依
src/transpile.js        TypeScript -> ESM，經 node:module
```

`index.js` 只 import `node:` 內建模組加本套件自身，並宣告 `inject: ["tools"]`——它唯一需要的服務。skill 與設定經能力檢查後的 `ctx.inject` 觸達，所以不組合 skill 註冊表的 profile 只是不掛載 skill，而不是啟動失敗。

## 授權

MIT
