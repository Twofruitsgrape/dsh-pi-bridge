[English](../../README.md) · **日本語**

# dsh-pi-bridge

ひとつのプラグインで、ふたつのホストを。pi にインストールすれば pi が DeepSeek Harness プラグインを使えるようになり、DSH にインストールすれば DSH が pi プラグインを使えるようになります。どちらの側も、相手側のコードを「翻訳」して動かすことはしません。プラグインは常に自分本来のホストの中で実行されます——そのホストの API が本物だからです——もう一方の側は呼び出しを中継するだけです。

```text
# pi
pi install npm:dsh-pi-bridge            # もしくは: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

インストール後、ホストを再起動してください。両方のキーワード（`pi-package` と `dsh-plugin`）が宣言されているため、それぞれのエコシステムのマーケットでもこのパッケージが見つかります。

## 各ホストで得られるもの

| | pi | DSH |
|---|---|---|
| 相手側プラグインの利用 | `dsh_install`、`dsh_preview`、`/dsh-install`、`/dsh-preview` | `pi_install`、`pi_preview` |
| ブリッジ済み項目の管理 | `/bridge-list`、`/bridge-remove` | `bridge_list`、`bridge_remove`、`bridge_status` |
| スキル | `skills/dsh-pi-bridge/SKILL.md` | 同じ `SKILL.md` をスキルレジストリ経由でマウント |

どちらの側も同一のソース文法を使います：`npm:<pkg>[@ver]`、`git:github.com/<owner>/<repo>[@ref]`、`github:<owner>/<repo>`、リポジトリ URL、ローカルパス——各ホストが元から受け付ける形式とまったく同じです。

実際のセッションの一部をそのまま収録：本物の DSH 起動、本物のモデル、実際に公開されている pi パッケージのインストール。

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # pi パッケージ由来のツール
  -> ライブの検索結果。パッケージ自身の provider 設定で取得
```

## 仕組み

### pi プラグインが DSH に入る：監督された pi プロセス

`pi_install` はパッケージをブリッジのキャッシュに展開し、本物の依存をインストールした上で、ブリッジが監督する pi プロセス（`pi --mode rpc`）の中でロードします。pi が報告した登録項目はすべて DSH のツールとなり、呼び出しは pi へ転送され、pi が計算した結果が返ります。`SKILL.md` ディレクトリはデータとして `ctx.skills` 経由でマウントされます。パッケージから見えるのは、pi 本物の `registerTool`・`registerProvider`・モデルレジストリ・provider 認証情報です——ネットワークやモデルに触るパッケージは、pi ユーザーの手元とまったく同じように振る舞います。

この設計は、初期の「登録項目を DSH 側にリプレイし、スタブ化した import に依存する」方式に取って代わるものでした。あのバージョンはモックテストはすべて通過しましたが、本物のパッケージの前で崩壊しました——スタブ化された依存は、動かないツールでしかないからです。ネイティブホストへの転送こそ、結果について正直であり続けられる唯一の形です。

### DSH プラグインが pi に入る：生きている DSH セッション

DSH バンドルが必要とするのは本物の `ctx.tools`・`ctx.llm`・スキルレジストリなので、`dsh_install` は生きている DSH セッション自身にバンドルをロードさせます。障害はここにあります：プラグインマネージャがインストールしたバンドルはプロフィールの `node_modules` 配下のシンボリックリンクであり、素の `@deepseek-ai/*` は解決できません——実際に `MODULE_NOT_FOUND` が報告されました。`src/dsh-loader.js` はまさにこうした指定子を、稼働中のビルドが持つモジュールの URL（本物のパッケージであり、スタブではありません）へ書き換えます。相対 import、`node:`、サードパーティ import はそのまま残ります。バンドルはホストへ登録し、pi には各ケイパビリティに対応する転送ツールが届きます。

エンドポイントはデフォルトで閉じています。通常の DSH 起動はポートを開きません：

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # DSH 側
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # pi 側
```

127.0.0.1 のみにバインドし、クライアントはループバック以外のアドレスを拒否します。生きた DSH に届かない場合、`dsh_install` はその旨を正しく伝え、翻訳モードへフォールバックします。転送が成功したふりはしません。

### どちらのホストも届かないとき

ブリッジはそれでもソースを解決し、TypeScript をコンパイルし（`node:module` の `stripTypeScriptTypes`。ツールチェーンのダウンロード不要）、パッケージが何を登録するかを捕捉するため、`preview` はどこでも機能します。登録項目の別ホストへのリプレイは同ホストのシナリオと、ペイロード全体がデータであるバンドルのために取ってあります。純粋なスキルディレクトリの DSH バンドルには呼び出せるものがありませんが、スキル自体は渡ります。両ホストとも [Agent Skills 仕様](https://agentskills.io/specification) を実装しています。

### パラメータと結果の形状

DSH ツールはプロパティ仕様テーブル（`{ text: { type: "string", required: true } }`）を運び、`@deepseek-ai/dsh-tools` が JSON Schema へコンパイルします。pi ツールは JSON Schema（TypeBox）を直接持ちます。`src/schema.js` が双方向に変換し、結果も同じ投影を経ます：pi の `{ content: [{ type: "text" }] }` と DSH の `{ ok, result }` が互いに変換されます。ホストは登録時にスキーマを検証しますが、受け入れるサブセットはドラフト JSON Schema より狭い——プロパティノード上の `required` マーカーや、出力スキーマのオブジェクトレベルの `required` 配列は、プラグイン全体のアクティブ化を失敗させます。これらの規則はインストール済みホストへの実測から得たもので、テストスイートに対応するアサーションがあります。

## 検証済み：何をどう検証したか

以下のどれ一つとして、モックではなく本物のホストに対して測りました：

- 本物の DSH 起動・本物のモデルで `npm:pi-web-access` をインストールし、そこ経由で `web_web_search` を呼ぶ（結果はパッケージ自身の provider が取得）
- 本物の DSH セッションが、素の `@deepseek-ai/dsh-tools` を import するバンドルをロードし、loopback 経由で別プロセスからそのツールを呼ぶ
- pi が外部バンドルに出会うのと同じ機構で、このブリッジ自身の DSH エントリを実行

そのうちのどれもが、モックでは捉えられなかったバグを掴みました：公開マニフェストから漏れたファイル、ホストが拒否してプラグインが静かに無効になる出力スキーマ、ホストプロセス内で `process.execPath` が node ではなくアプリを指す件、デーモンが既にパッケージをロード済みのため再インストール時にゼロ能力を報告する件、プロパティ代入を禁止するスコープ、サービス起動のファイバー外で走るサーバハンドラ、重複ツール名を拒否するホスト。

```bash
npm test                # オフラインスイート全部
npm run test:offline    # パイプライン + 両側ホストエントリ
npm run test:proxy      # デーモン、DSH 側と pi 側の転送
npm run test:host       # インストール済み DSH ビルドに対して（説明参照）
npm run test:network    # npm と GitHub から来る本物の公開パッケージ
npm run test:live       # 上記を本物の稼働 pi に対して
```

`test:host` はインストール済みホストの asar 内部から、ホスト自身の `@deepseek-ai/dsh-tools` を読みます。これは Electron パッチ付きの fs でしか読めないため、ホストプロセス内で実行してください。普通の node では明確に SKIP を報告します——ホストに拒否されたとほのめかすことはありません。

オフラインスイートはフィクスチャを手作りします——TypeBox ビルダーを使う TypeScript 製 pi 拡張、`defineTool` を使う DSH バンドル、素のホストパッケージを import するバンドル——そしてパイプライン全体を録画スタブに対して走らせ、ブリッジ経由で出てきたツールを実際に実行します。一部の規則は静的アサーションです。それらは本物の起動でしか姿を現さないからです：ホストが受け入れるスキーマの形、公開すべきファイル、解析対象バンドルがプロセスを起こしたりポートを束ねたりしてはならないこと。

## 越境しないもの

ブリッジはこうしたケースを静かに失敗させるのではなく、正直に報告します：

- **ホスト UI**：DSH のブラウザページ / `ctx.slots`、pi の TUI レンダラー、`ctx.ui`、キーバインド、CLI フラグ。
- **ホストに登録されるモデルアダプタ**：provider を追加するパッケージは自分のホストに対して行います——それが「翻訳しない」の意味です——pi の provider は pi に、DSH の adapter は DSH に落ちます。
- **呼び出せるものを何も持たない DSH バンドル**：純粋な UI や設定オーバーレイには転送すべきツールがありません。preview はその旨を正しく伝え、能力を捏造しません。
- **対話的ホストを要求するパッケージ**：転送呼び出しは進捗をストリームできますが、相手側でピッカーをポップアップすることはできません。

## 永続化

登録項目は即座に現在のセッションに落ちます。各ホストはプラグインロード時に `~/.dsh-pi-bridge/bridges.json` から自分が記録した内容を再ロードするため、インストールは再起動を越えて存続します——DSH セッションを再起動してブリッジ経由のツールが場に在ることを確認済みです。再ロードはキャッシュの読み宛てのみ：ホスト起動はネットワークダウンロードを決して待たず、キャッシュが消去されていればハングではなく利用不可を報告します。再起動によって、他のクライアント（Web GUI、第二のウィンドウ）も新しいツールを見られるようになります。それらは起動時にツールリストを組み立てるためです。バンドル設定の `restoreOnLoad: false` で無効化できます。

どのホストの設定にも書き込みません。`bridge_remove` はブリッジを忘れ、そのビルドディレクトリを消去します。稼働中のプロセスに登録済みのツールは再起動まで残ります。ホスト状態を静かに登録解除する方が、見え続けるより悪いからです。

## セキュリティ

ブリッジされたパッケージは、**実行される側のホストで、あなたの権限でコードを実行します**。拡張ホストはどれも同じ要求を課しますが、このパッケージは別のエコシステムから来て、そのマーケットの審査を経ていないため、要求はさらに高くなります。まずソースを読んでください。`preview` は解析と検査のみを行い、何も登録しません。

転送にサンドボックスはありません。パッケージは自分のホストの完全な信頼で実行されます。それが動作する理由です。loopback エンドポイントは 127.0.0.1 のみにバインドし、`DSH_PI_BRIDGE_DSH_SERVE` が設定されない限り開きません。クライアントはループバック以外のアドレスを拒否します。そのポートに繋げる者は誰でも、セッションがロード済みのツールを呼べます。必要のない限り開かないでください。

## レイアウト

```text
index.js                DSH エントリ：name / inject / apply(ctx)、すなわち pi_* ツール
extensions/index.js     pi エントリ：default(pi) ファクトリ、dsh_* ツールとコマンド
skills/dsh-pi-bridge/   SKILL.md、両ホストで共用
cordis.patch.yml        DSH バンドルマウント（プラグインパネルのトグル先）
daemon/run.mjs          監督された pi プロセス。自ツールの loopback 前面
daemon/bootstrap.js     pi 本物の拡張ローダによって pi 内部へロードされる
src/proxy.js            DSH 側：デーモンの起動/再利用、呼び出し転送
src/dsh-loader.js       DSH 側：生きた scope に対して実行時にバンドルをロード
src/serve.js            DSH 側：もう一方のホストのための loopback エンドポイント
src/dsh-host-client.js  pi 側：生きている DSH セッションと通信
src/resolve.js          npm / git / url / ローカルのソースを依存インストール込みでキャッシュへ
src/load.js             ミラーツリーの構築、TS コンパイル、本物の依存インストール
src/manifest.js         キーワード・マニフェスト・ディレクトリの形状からホストを識別
src/capture.js          両エントリ規約の録画スタブホスト
src/schema.js           パラメータスキーマの双方向変換
src/capabilities.js     正規化されたケイパビリティモデル。結果の投影
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          ホスト起動時に記録済みブリッジを再ロード
src/stubs.js            preview 用の import スキャンとスタブ生成
src/tar.js              gzipped-tar 読み手。依存ゼロ
src/transpile.js        TypeScript -> ESM。node:module 経由
```

`index.js` は `node:` 組み込みと自己パッケージだけを import し、`inject: ["tools"]` を宣言しています——それが唯一必要とするサービスです。スキルと設定は能力チェック済みの `ctx.inject` 経由で手が届きます。スキルレジストリを組み込まないプロフィールは、スキルをマウントしないだけで、起動は失敗しません。

## ライセンス

MIT
