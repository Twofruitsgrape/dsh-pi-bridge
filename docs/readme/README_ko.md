[English](../../README.md) · **한국어**

# dsh-pi-bridge

플러그인 하나, 호스트 둘. pi에 설치하면 pi가 DeepSeek Harness 플러그인을 쓸 수 있고, DSH에 설치하면 DSH가 pi 플러그인을 쓸 수 있습니다. 어느 쪽도 상대편 코드를 "번역"해서 돌리지 않습니다. 플러그인은 언제나 자기 본래의 호스트 안에서 실행됩니다. 그 호스트의 API가 진짜이기 때문입니다. 다른 한쪽은 호출을 전달할 뿐입니다.

```text
# pi
pi install npm:dsh-pi-bridge            # 또는: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

설치 후 호스트를 재시작하세요. 두 키워드(`pi-package`와 `dsh-plugin`)가 모두 선언되어 있어서 각 생태계의 마켓에서도 이 패키지를 찾을 수 있습니다.

## 각 호스트에서 얻는 것

| | pi | DSH |
|---|---|---|
| 상대편 플러그인 사용 | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| 브리지된 항목 관리 | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| 스킬 | `skills/dsh-pi-bridge/SKILL.md` | 같은 `SKILL.md`를 스킬 레지스트리를 통해 마운트 |

양쪽 모두 동일한 소스 문법을 씁니다: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, 저장소 URL, 로컬 경로 — 각 호스트가 원래 받아들이던 형식 그대로입니다.

실제 세션 한 부분을 그대로 기록: 진짜 DSH 기동, 진짜 모델, 실제 공개된 pi 패키지 설치.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # pi 패키지에서 온 도구
  -> 실시간 검색 결과, 패키지 자신의 provider 설정으로 가져옴
```

## 작동 방식

### pi 플러그인이 DSH로 들어올 때: 감독되는 pi 프로세스

`pi_install`은 패키지를 브리지 캐시에 실체화하고, 진짜 의존성을 설치한 뒤, 브리지가 감독하는 pi 프로세스(`pi --mode rpc`) 안에서 로드합니다. pi가 보고한 등록 항목은 모두 DSH의 도구가 되고, 호출은 pi로 전달되어 pi가 산출한 결과가 돌아옵니다. `SKILL.md` 디렉터리는 데이터로서 `ctx.skills`를 통해 마운트됩니다. 패키지가 보는 것은 pi의 진짜 `registerTool`, `registerProvider`, 모델 레지스트리, provider 자격증명입니다. 네트워크나 모델에 접근하는 패키지는 pi 사용자의 손에 있는 것과 완전히 똑같이 동작합니다.

이 설계는 초기의 "등록 항목을 DSH 쪽으로 리플레이하고 스텁 처리된 import에 의존하는" 방식을 대체했습니다. 그 버전은 모의 테스트는 모두 통과했지만 실제 패키지 앞에서 무너졌습니다. 스텁화된 의존성은 동작하지 않는 도구일 뿐이기 때문입니다. 네이티브 호스트로의 전달만이 결과에 대해 정직할 수 있는 형태입니다.

### DSH 플러그인이 pi로 들어갈 때: 살아 있는 DSH 세션

DSH 번들이 필요한 것은 진짜 `ctx.tools`, `ctx.llm`, 스킬 레지스트리이므로, `dsh_install`은 살아 있는 DSH 세션 스스로에게 번들을 로드하도록 요청합니다. 장애물은 여기에 있습니다: 플러그인 매니저가 설치한 번들은 프로파일의 `node_modules` 아래 심볼릭 링크이고, 벗겨진 `@deepseek-ai/*`는 해석되지 않습니다. 실측에서 `MODULE_NOT_FOUND`가 보고되었습니다. `src/dsh-loader.js`는 바로 이런 지정자들을, 실행 중인 빌드가 가진 모듈의 URL(진짜 패키지이지 스텁이 아님)로 바꿉니다. 상대 import, `node:`, 서드파티 import는 그대로 남습니다. 번들은 호스트에 등록되고, pi에는 각 캐퍼빌리티에 대응하는 전달 도구가 도착합니다.

엔드포인트는 기본으로 닫혀 있습니다. 평범한 DSH 기동은 포트를 열지 않습니다:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # DSH 쪽
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # pi 쪽
```

127.0.0.1에만 바인드하고, 클라이언트는 루프백이 아닌 주소를 거부합니다. 살아 있는 DSH에 닿지 않으면 `dsh_install`은 그 사실을 정직하게 말하고 번역 모드로 폴백합니다. 전달이 성공한 척하지 않습니다.

### 두 호스트 모두 닿지 않을 때

브리지는 그래도 소스를 해석하고, TypeScript를 컴파일하고(`node:module`의 `stripTypeScriptTypes`, 툴체인 다운로드 불필요), 패키지가 무엇을 등록할지 포착하므로, `preview`는 어디서든 동작합니다. 등록 항목의 다른 호스트로의 리플레이는 같은 호스트 시나리오와, 페이로드 전체가 데이터인 번들을 위해 남겨둡니다. 순수 스킬 디렉터리인 DSH 번들에는 호출할 것이 없지만, 스킬 자체는 넘어갑니다. 두 호스트 모두 [Agent Skills 규격](https://agentskills.io/specification)을 구현합니다.

### 파라미터와 결과의 형태

DSH 도구는 속성 명세표(`{ text: { type: "string", required: true } }`)를 실고, `@deepseek-ai/dsh-tools`가 JSON Schema로 컴파일합니다. pi 도구는 JSON Schema(TypeBox)를 곧바로 실립니다. `src/schema.js`가 양방향으로 변환하고, 결과도 같은 투영을 거칩니다: pi의 `{ content: [{ type: "text" }] }`와 DSH의 `{ ok, result }`가 서로 변환됩니다. 호스트는 등록 시점에 스키마를 검증하며, 받아들이는 부분집합은 드래프트 JSON Schema보다 좁습니다. 속성 노드 위의 `required` 마커나, 출력 스키마의 객체 수준 `required` 배열은 플러그인 전체의 활성화를 막습니다. 이 규칙들은 설치된 호스트에 대한 실측에서 나왔고, 테스트 스위트에 대응하는 단언이 있습니다.

## 검증됨 — 무엇을 어떻게 검증했나

아래 항목은 모두 모형이 아니라 진짜 호스트를 상대로 측정했습니다:

- 진짜 DSH 기동, 진짜 모델로 `npm:pi-web-access`를 설치하고 거기 경유로 `web_web_search`를 호출(결과는 패키지 자신의 provider가 가져옴)
- 진짜 DSH 세션이 벗겨진 `@deepseek-ai/dsh-tools`를 import하는 번들을 로드하고, 루프백 경유로 별도 프로세스가 그 도구를 호출
- pi가 외부 번들과 만나는 같은 기제로 이 브리지 자신의 DSH 엔트리를 실행

그중 하나하나가 모형으로는 잡을 수 없던 버그를 잡았습니다: 공개 매니페스트에서 빠진 파일, 호스트가 거부해서 플러그인이 조용히 비활성되는 출력 스키마, 호스트 프로세스 안에서 `process.execPath`가 node가 아닌 앱을 가리키는 문제, 데몬이 이미 패키지를 로드한 탓에 재설치 시 제로 캐퍼빌리티를 보고하는 문제, 속성 할당을 금지하는 스코프, 서비스 기동 파이버 밖에서 도는 서버 핸들러, 중복 도구 이름을 거부하는 호스트.

```bash
npm test                # 오프라인 스위트 전부
npm run test:offline    # 파이프라인 + 양쪽 호스트 엔트리
npm run test:proxy      # 데몬, DSH 쪽과 pi 쪽 전달
npm run test:host       # 설치된 DSH 빌드 상대(설명 참조)
npm run test:network    # npm과 GitHub에서 오는 실제 공개 패키지
npm run test:live       # 위 테스트를 실제 가동 중인 pi 상대로
```

`test:host`는 설치된 호스트의 asar 내부에서 호스트 자신의 `@deepseek-ai/dsh-tools`를 읽습니다. Electron 패치가 붙은 fs로만 읽을 수 있으므로 호스트 프로세스 안에서 실행하세요. 평범한 node에서는 SKIP을 명확히 보고합니다. 호스트가 우리를 거부했다고 암시하지 않습니다.

오프라인 스위트는 픽스처를 손으로 만듭니다 — TypeBox 빌더를 쓰는 TypeScript pi 확장, `defineTool`을 쓰는 DSH 번들, 벗겨진 호스트 패키지를 import하는 번들 — 그리고 파이프라인 전체를 녹화 스텁 상대로 돌리고, 브리지를 통해 나온 도구를 실제로 실행합니다. 일부 규칙은 정적 단언입니다. 진짜 기동에서만 드러나는 것들이기 때문입니다: 호스트가 받아들이는 스키마 형태, 공개해야 할 파일, 분석 대상 번들이 프로세스를 띄우거나 포트를 묶어서는 안 된다는 것.

## 경계를 넘지 않는 것

브리지는 이런 경우를 조용히 실패시키지 않고 정직하게 보고합니다:

- **호스트 UI**: DSH 브라우저 페이지 / `ctx.slots`, pi의 TUI 렌더러, `ctx.ui`, 키바인딩, CLI 플래그.
- **호스트에 등록되는 모델 어댑터**: provider를 추가하는 패키지는 자기 호스트에 대해 합니다. 그것이 "번역하지 않는다"의 의미입니다. pi의 provider는 pi에, DSH의 adapter는 DSH에 떨어집니다.
- **호출 가능한 것이 아무것도 없는 DSH 번들**: 순수 UI나 설정 오버레이는 전달할 도구가 없습니다. preview는 그 사실을 정직하게 말하고, 케퍼빌리티를 날조하지 않습니다.
- **대화형 호스트를 요구하는 패키지**: 전달 호출은 진행 상황을 스트리밍할 수 있지만, 다른 쪽에서 피커를 띄울 수는 없습니다.

## 영속화

등록 항목은 즉시 현재 세션에 내려앉습니다. 각 호스트는 플러그인 로드 시점에 `~/.dsh-pi-bridge/bridges.json`에서 자신이 기록한 내용을 다시 로드하므로, 설치는 재시작을 넘어 살아남습니다. DSH 세션을 재시작해 브리지 도구가 자리에 있는 것을 확인했습니다. 재로드는 캐시 읽기에 그칩니다. 호스트 기동은 네트워크 다운로드를 절대 기다리지 않고, 캐시가 지워졌다면 매달리지 않고 사용 불가를 보고합니다. 재시작 덕분에 다른 클라이언트(웹 GUI, 두 번째 창)도 새 도구를 볼 수 있습니다. 그들은 기동 시점에 도구 목록을 조립하기 때문입니다. 번들 설정의 `restoreOnLoad: false`로 끌 수 있습니다.

어떤 호스트의 설정에도 쓰지 않습니다. `bridge_remove`는 브리지를 잊고 그 빌드 디렉터리를 지웁니다. 가동 중 프로세스에 등록된 도구는 재시작까지 남습니다. 호스트 상태를 조용히 등록 해제하는 게 계속 보이는 것보다 나쁘기 때문입니다.

## 보안

브리지된 패키지는 **실행되는 쪽 호스트에서 당신의 권한으로 코드를 실행합니다**. 확장 호스트는 모두 같은 요구를 걸지만, 이 패키지는 다른 생태계에서 왔고 그 마켓의 검 심을 거치지 않았으므로 요구는 더 높습니다. 먼저 소스를 읽으세요. `preview`는 해석과 검사만 하고 아무것도 등록하지 않습니다.

전달에 샌드박스는 없습니다. 패키지는 자기 호스트의 완전한 신뢰로 실행됩니다. 그래서 동작하는 것입니다. 루프백 엔드포인트는 127.0.0.1에만 바인드하고, `DSH_PI_BRIDGE_DSH_SERVE`를 설정하지 않는 한 열리지 않습니다. 클라이언트는 루프백이 아닌 주소를 거부합니다. 그 포트에 연결할 수 있는 자는 누구든 세션이 로드한 도구를 호출할 수 있습니다. 필요 없으면 열지 마세요.

## 레이아웃

```text
index.js                DSH 엔트리: name / inject / apply(ctx), 즉 pi_* 도구
extensions/index.js     pi 엔트리: default(pi) 팩토리, dsh_* 도구와 명령
skills/dsh-pi-bridge/   SKILL.md, 양쪽 호스트 공용
cordis.patch.yml        DSH 번들 마운트(플러그인 패널 토글 대상)
daemon/run.mjs          감독되는 pi 프로세스. 자기 도구의 루프백 전면
daemon/bootstrap.js     pi의 진짜 확장 로더가 pi 내부로 로드
src/proxy.js            DSH 쪽: 데몬 기동/재사용, 호출 전달
src/dsh-loader.js       DSH 쪽: 살아 있는 스코프 상대로 실행 시점에 번들 로드
src/serve.js            DSH 쪽: 다른 호스트를 위한 루프백 엔드포인트
src/dsh-host-client.js  pi 쪽: 살아 있는 DSH 세션과 통신
src/resolve.js          npm / git / url / 로컬 소스를 의존성 설치까지 해서 캐시로
src/load.js             미러 트리 구축, TS 컴파일, 진짜 의존성 설치
src/manifest.js         키워드·매니페스트·디렉터리 형태로 호스트 식별
src/capture.js          양쪽 엔트리 규약의 녹화 스텁 호스트
src/schema.js           파라미터 스키마 양방향 변환
src/capabilities.js     정규화된 캐퍼빌리티 모델, 결과 투영
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          호스트 기동 시 기록된 브리지 재로드
src/stubs.js            preview용 import 스캔과 스텁 생성
src/tar.js              gzipped-tar 리더, 의존성 없음
src/transpile.js        TypeScript -> ESM, node:module 경유
```

`index.js`는 `node:` 내장과 자기 패키지만 import하고 `inject: ["tools"]`를 선언합니다 — 유일하게 필요한 서비스입니다. 스킬과 설정은 케퍼빌리티 검사를 마친 `ctx.inject`를 통해 닿습니다. 스킬 레지스트리를 넣지 않은 프로파일은 스킬을 마운트하지 않을 뿐, 기동이 실패하지는 않습니다.

## 라이선스

MIT
