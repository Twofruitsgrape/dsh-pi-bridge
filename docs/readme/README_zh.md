[English](../../README.md) · **简体中文**

# dsh-pi-bridge

一个插件，两个宿主。装进 pi，pi 就能使用 DeepSeek Harness 插件；装进 DSH，DSH 就能使用 pi 插件。任何一侧都不靠翻译对方的代码来运行插件：插件始终在它自己的宿主内执行——那里的宿主 API 是真实的——另一侧只负责调用。

```text
# pi
pi install npm:dsh-pi-bridge            # 或者: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

安装后重启宿主。两个关键字（`pi-package` 和 `dsh-plugin`）均已声明，所以各自生态的市场都能搜到这个包。

## 每个宿主里你能得到什么

| | pi | DSH |
|---|---|---|
| 使用另一侧的插件 | `dsh_install`、`dsh_preview`、`/dsh-install`、`/dsh-preview` | `pi_install`、`pi_preview` |
| 管理已桥接的内容 | `/bridge-list`、`/bridge-remove` | `bridge_list`、`bridge_remove`、`bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | 同一个 `SKILL.md`，经 skill 注册表挂载 |

两侧使用同一套来源语法：`npm:<pkg>[@ver]`、`git:github.com/<owner>/<repo>[@ref]`、`github:<owner>/<repo>`、仓库 URL 或本地路径——与各宿主本来接受的格式完全一致。

一段真实的会话记录，原文照录：真实 DSH 启动、真实模型、安装一个真实发布的 pi 包。

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # 一个来自 pi 包的工具
  -> 实时搜索结果，由包自己用自己的 provider 配置抓取
```

## 工作原理

### pi 插件进入 DSH：受监督的 pi 进程

`pi_install` 把包物化到桥的缓存里，安装它真实的依赖，然后在一个由桥监督的 pi 进程（`pi --mode rpc`）内加载它。pi 上报的每一个注册项都会成为 DSH 的一个工具，调用时转发给 pi 并返回 pi 算出的结果。`SKILL.md` 目录作为数据经 `ctx.skills` 挂载。包看到的是 pi 真实的 `registerTool`、`registerProvider`、模型注册表和 provider 凭据——一个要访问网络或模型的包，行为和 pi 用户手里完全一样。

这一设计取代了早期把注册项重放到 DSH、依赖桩化 import 的方案。那个版本通过了所有 mock 测试，却在真实包面前溃败——因为一个被桩化的依赖就是一个跑不起来的工具。转发进原生宿主，是唯一能对结果保持诚实的版本。

### DSH 插件进入 pi：活着的 DSH 会话

一个 DSH bundle 需要的是真实的 `ctx.tools`、`ctx.llm` 和 skill 注册表，所以 `dsh_install` 请求活着的 DSH 会话自己加载这个 bundle。障碍在于：插件管理器装好的 bundle 是 profile `node_modules` 下的一个 symlink，裸引 `@deepseek-ai/*` 无法解析——实测报 `MODULE_NOT_FOUND`。`src/dsh-loader.js` 恰好把这些说明符重写为运行中 build 自带模块的 URL（是真包，不是桩），相对导入、`node:` 与第三方导入则原样保留。bundle 向宿主注册，pi 收到每个能力对应的转发工具。

端点默认关闭，普通 DSH 启动不开任何端口：

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # DSH 侧
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # pi 侧
```

只绑定 127.0.0.1，客户端拒绝非回环地址。没有可达的活 DSH 时，`dsh_install` 会如实说明并回退到翻译模式，而不是假装转发成功。

### 两个宿主都不可达时

桥仍然会解析源、编译 TypeScript（`node:module` 的 `stripTypeScriptTypes`，无需下载工具链）并捕获包会注册什么，所以 `preview` 在任何地方都能用。把注册项重放到另一宿主保留给同宿主场景，以及整个载荷都是数据的 bundle——一个纯 skill 目录的 DSH bundle 没有可调用的东西，skill 本身照样能过去。两个宿主都实现了 [Agent Skills 规范](https://agentskills.io/specification)。

### 参数与结果形态

DSH 工具携带属性规格表（`{ text: { type: "string", required: true } }`），由 `@deepseek-ai/dsh-tools` 编译成 JSON Schema；pi 工具直接携带 JSON Schema（TypeBox）。`src/schema.js` 双向转换，结果也做同样的投影：pi 的 `{ content: [{ type: "text" }] }` 与 DSH 的 `{ ok, result }` 互转。宿主在注册时校验 schema，且接受的子集比 draft JSON Schema 窄——属性节点上的 `required` 标记，或输出 schema 里对象级的 `required` 数组，会让整个插件无法激活。这些规则来自对已安装宿主的实测，测试套件中有对应断言。

## 已验证，以及验证方式

以下每一条都对着真实宿主测过，不是对着 mock：

- 真实 DSH 启动、真实模型，安装 `npm:pi-web-access` 并通过它调用 `web_web_search`（结果由包自己的 provider 抓取）
- 真实 DSH 会话加载一个裸引 `@deepseek-ai/dsh-tools` 的 bundle，然后经 loopback 提供给独立进程调用它的工具
- pi 经由外来 bundle 会遇到的同一套机制运行本桥自己的 DSH 入口

其中每一条都抓到了一个 mock 抓不到的 bug：发布清单里漏掉的文件、宿主拒绝导致插件静默失效的输出 schema、宿主进程里 `process.execPath` 指向应用而非 node、重装时因守护进程已加载过包而上报零能力、禁止属性赋值的 scope、在激活服务的 fiber 之外运行的 server handler、宿主拒绝重复工具名。

```bash
npm test                # 全部离线套件
npm run test:offline    # pipeline + 两侧宿主入口
npm run test:proxy      # daemon、DSH 侧与 pi 侧转发
npm run test:host       # 对着已安装的 DSH build（见说明）
npm run test:network    # 来自 npm 和 GitHub 的真实发布包
npm run test:live       # 上面的测试对着真正运行中的 pi
```

`test:host` 从已安装宿主的 asar 内部读取宿主自己的 `@deepseek-ai/dsh-tools`，只有带 Electron 补丁的 fs 才能读到；请在宿主进程里运行它。普通 node 下它会明确报告 SKIP，而不是暗示宿主拒绝了我们。

离线套件手工搭建夹具——一个用 TypeBox builder 的 TypeScript pi 扩展、一个用 `defineTool` 的 DSH bundle、一个裸引宿主包的 bundle——然后让整条流水线对着录音替身跑，并真正执行桥接出来的工具。有些规则用静态断言，因为它们只在真实启动时暴露：宿主接受的 schema 形态、必须发布的文件、分析 bundle 不得起进程不得绑端口。

## 不会跨宿主的内容

桥会如实报告这些情况，而不是悄悄失败：

- **宿主 UI**：DSH 浏览器页面 / `ctx.slots`，pi 的 TUI 渲染器、`ctx.ui`、快捷键、CLI 标志。
- **注册进宿主的模型适配器**：添加 provider 的包是对自己的宿主做的——这正是"不翻译"的意义所在——pi 的 provider 落进 pi，DSH 的 adapter 落进 DSH。
- **没有任何可调用物的 DSH bundle**：纯 UI 或纯设置覆盖层没有可转发的工具。preview 会如实说明，而不是编造能力。
- **需要交互式宿主的包**：转发调用可以流式上报进度，但无法在另一侧弹出选择器。

## 持久化

注册项立即落在当前会话。每个宿主在插件加载时从 `~/.dsh-pi-bridge/bridges.json` 重载自己记录过的内容，所以安装能挺过重启——已通过重启 DSH 会话并发现桥接工具已在场验证。重载只读缓存：宿主启动绝不等待网络下载，缓存被清掉时桥会报告不可用而不是挂起。重启也让其他客户端（Web GUI、第二个窗口）能看到新工具，因为它们在启动时构建工具列表。bundle 配置里 `restoreOnLoad: false` 可关闭。

不向任何宿主的设置里写东西。`bridge_remove` 忘记一个桥并清掉它的 build 目录；已注册进运行中进程的工具会留到重启，因为静默注销宿主状态比让它继续可见更糟。

## 安全

桥接的包**以你的权限在它运行的那一侧执行代码**——每个扩展宿主都有同样的要求，而这个包来自另一个生态、未经其市场审查，所以要求更高。先读它的源码；`preview` 只解析和检视，不注册任何东西。

转发不做沙箱：包带着自己宿主的全部信任运行，这正是它能工作的原因。loopback 端点只绑定 127.0.0.1，除非设置 `DSH_PI_BRIDGE_DSH_SERVE` 否则不开启，客户端拒绝非回环地址。任何能连上该端口的人都能调用会话已加载的工具，所以不需要就别开。

## 目录结构

```text
index.js                DSH 入口：name / inject / apply(ctx)，即 pi_* 工具
extensions/index.js     pi 入口：default(pi) 工厂，dsh_* 工具与命令
skills/dsh-pi-bridge/   SKILL.md，两侧宿主共用
cordis.patch.yml        DSH bundle 挂载（插件面板的开关目标）
daemon/run.mjs          受监督的 pi 进程；其工具的 loopback 前端
daemon/bootstrap.js     由 pi 真实的扩展加载器载入 pi 内部
src/proxy.js            DSH 侧：启动/复用 daemon，转发调用
src/dsh-loader.js       DSH 侧：对着活 scope 在运行时加载 bundle
src/serve.js            DSH 侧：给另一个宿主用的 loopback 端点
src/dsh-host-client.js  pi 侧：与活 DSH 会话通信
src/resolve.js          npm / git / url / 本地来源进缓存，带依赖安装
src/load.js             构建镜像树、编译 TS、安装真实依赖
src/manifest.js         从关键字、清单与目录形态做宿主识别
src/capture.js          两种入口约定的录音替身宿主
src/schema.js           参数 schema 双向转换
src/capabilities.js     归一化的能力模型，结果投影
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          宿主启动时重载已记录的桥
src/stubs.js            preview 用的 import 扫描与桩生成
src/tar.js              gzipped-tar 读取器，零依赖
src/transpile.js        TypeScript -> ESM，经 node:module
```

`index.js` 只 import `node:` 内建模块加本包自身，并声明 `inject: ["tools"]`——它唯一需要的服务。skill 与设置经能力检查后的 `ctx.inject` 触达，所以不组合 skill 注册表的 profile 只是不挂载 skill，而不是启动失败。

## 许可证

MIT
