[English](../../README.md) · **Polski**

# dsh-pi-bridge

Jeden plugin, dwa hosty. Zainstalowany w pi, pozwala pi używać wtyczek DeepSeek Harness; zainstalowany w DSH, pozwala DSH używać wtyczek pi. Żadna ze stron nie wykonuje cudzego kodu, „przekładając" go: plugin zawsze działa we własnym hoście — tam, gdzie API hosta jest prawdziwe — a druga strona jedynie przekazuje wywołania.

```text
# pi
pi install npm:dsh-pi-bridge            # albo: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

Po zainstalowaniu zrestartuj hosta. Oba słowa kluczowe (`pi-package` i `dsh-plugin`) są zadeklarowane, więc marketplace każdego ekosystemu znajduje ten pakiet.

## Co dostajesz w każdym hoście

| | pi | DSH |
|---|---|---|
| Używanie wtyczek drugiej strony | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| Zarządzanie przebranymi | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | ta sama `SKILL.md`, domontowana przez rejestr skilli |

Obie strony używają tej samej gramatyki źródeł: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, URL repozytorium albo ścieżka lokalna — dokładnie te formaty, które każdy host i tak przyjmuje.

Wycinek prawdziwej sesji, dosłownie: prawdziwy start DSH, prawdziwy model, instalacja faktycznie opublikowanego pakietu pi.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # narzędzie przychodzące z pakietu pi
  -> żywe wyniki wyszukiwania, pozyskane przez własnego providera pakietu z jego konfiguracją
```

## Jak to działa

### Wtyczki pi wchodzące do DSH: nadzorowany proces pi

`pi_install` ulażestawia pakiet w cache mostu, instaluje jego prawdziwe zależności, a potem ładuje go w nadzorowanym przez most procesie pi (`pi --mode rpc`). Każdy punkt, o którym zameldował pi, staje się narzędziem w DSH; wywołania idą nadal do pi i zwracają wynik wyliczony przez pi. Katalog `SKILL.md` montuje się jako dane przez `ctx.skills`. Pakiet widzi prawdziwe `registerTool` pi, jego `registerProvider`, rejestr modeli i dane uwierzytelniające providerów — pakiet dotykający sieci albo modeli zachowuje się dokładnie tak, jak w rękach użytkownika pi.

Ten projekt zastąpił dawną drogę: replikowania rejestracji w DSH i oparcia się na importach zaślepkowych. Ta wersja przechodziła wszystkie testy z podstawkami i sypiała się w obliczu prawdziwych pakietów — bo import zaślepiony to narzędzie, które nie działa. Przekazywanie do rodzimego hosta to jedyna forma, która może pozostać uczciwa wobec wyników.

### Wtyczki DSH wchodzące do pi: żywa sesja DSH

Bundle DSH wymaga prawdziwego `ctx.tools`, prawdziwego `ctx.llm` i rejestru skilli, więc `dsh_install` prosi żywą sesję DSH, by sama wczytała bundle. Przeszkoda leży tu: bundle zainstalowany przez zarządcę wtyczek to symlink pod `node_modules` profilu, a nagie wskazania `@deepseek-ai/*` się nie rozwiązują — pomiar dał `MODULE_NOT_FOUND`. Właśnie na to jest `src/dsh-loader.js`: przepisuje te oznaczenia na adresy URL modułów, które niesie działający build (prawdziwe pakiety, nie zaślepki); importy względne, `node:` i zewnętrzne zostają bez zmian. Bundle rejestruje się u hosta, a pi dostaje przekazane narzędzie dla każdej zdolności.

Punkt końcowy jest domyślnie zamknięty; zwykły start DSH nie otwiera żadnego portu:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # strona DSH
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # strona pi
```

Bindowanie wyłącznie do 127.0.0.1; klient odrzuca adresy spoza loopback. Gdy żywe DSH jest nieosiągalne, `dsh_install` mówi to szczerze i cofa się do trybu przekładu, zamiast udawać, że przekazanie się udało.

### Gdy żaden host nie jest osiągalny

Most wciąż rozdziera źródło, kompiluje TypeScript (`stripTypeScriptTypes` z `node:module`, bez ściągnięcia toolchaina) i zapisuje, co pakiet by zarejestrował, dlatego `preview` działa wszędzie. Odtwarzanie rejestracji w drugim hoście zostaje scenariuszom w tym samym hoście i bundleom, których cały payload to dane — bundle DSH, czystego katalogu skilli, nie ma czego wywoływać, ale sam skill przechodzi. Oba hosty implementujują [specyfikację Agent Skills](https://agentskills.io/specification).

### Postać parametrów i wyników

Narzędzia DSH niosą tabelę specyfikacji własności (`{ text: { type: "string", required: true } }`), którą `@deepseek-ai/dsh-tools` kompiluje do JSON Schema; narzędzia pi niosą JSON Schema wprost (TypeBox). `src/schema.js` przekształca w obie strony, a wyniki przechodzą tę samą projekcję: `{ content: [{ type: "text" }] }` pi i `{ ok, result }` DSH przekładają się wzajemnie. Host waliduje schema przy rejestracji, a przyjmowany podzbiór jest ciasniejszy niż szkic JSON Schema — znacznik `required` na węźle własności albo tablica `required` na poziomie obiektu w schemie wyjścia walą aktywację całej wtyczki. Te reguły pochodzą z pomiarów na zainstalowanych hostach; zestaw testów niesie je jako asercje.

## Sprawdzone — i jak

Każdy z poniższych punktów mierzony był przeciw prawdziwym hostom, a nie przeciw podkładkom:

- Prawdziwy start DSH, prawdziwy model, instalacja `npm:pi-web-access` i wywołanie przez niego `web_web_search` (wyniki pozyskuje własny provider pakietu)
- Prawdziwa sesja DSH wczytuje bundle z nagim importem `@deepseek-ai/dsh-tools`, potem oddzielny proces wywołuje jego narzędzia przez loopback
- Ten most uruchamia własne wejście DSH tym samym mechanizmem, który obcy bundle spotyka w pi

Każdy z nich upolował błąd, nieosiągalny dla podstawki: plik zapomniany przez opublikowany manifest; schemę wyjścia, którą host odrzuca i która pozostawia wtyczkę cicho nieaktywną; `process.execPath`, który w procesie hosta wskazuje na aplację, nie na node; zgłaszanie zera zdolności przy reinstalacji, bo demon już wczytał pakiet; scope zakazujący przypisani własności; server handler biegnący poza włóknem startującym usługę; host odrzucający powtarzające się nazwy narzędzi.

```bash
npm test                # wszystkie zestawy offline
npm run test:offline    # rurociąg + wejścia hostów obu stron
npm run test:proxy      # demon, przekazywanie po stronie DSH i stronie pi
npm run test:host       # przeciw zainstalowanemu buildowi DSH (zob. uwaga)
npm run test:network    # faktycznie opublikowane pakiety z npm i GitHuba
npm run test:live       # powyższe przeciw pi naprawdę działającemu
```

`test:host` czyta własne `@deepseek-ai/dsh-tools` hosta od środka asara zainstalowanego hosta — zdoła tylko fs z łatą Electron, więc uruchamiaj je wewnątrz procesu hosta. Pod zwykłym node wyraźnie melduje SKIP, nie sugerując, że host nas odmówił.

Zestawy offline budują fixture ręcznie — rozszerzenie pi w TypeScript na builderze TypeBox, bundle DSH na `defineTool`, bundle z nagim importem pakietu hosta — a potem puszczają cały rurociąg przeciw nagranym podstawkom i naprawdę uruchamiają narzędzia, które wyszły mostem. Niektóre reguły żyją jako asercje statyczne, bo ujawniają się dopiero przy prawdziwym starcie: postaci schem przyjmowane przez hosta; pliki obowiązujące do publikacji; fakt, że analizowany bundle nie wolno wznosić procesów ani bindować portów.

## Co nie przekracza

Most powiadamia o takich wypadkach uczciwie, zamiast cichutko zawodzić:

- **UI hosta**: strony przeglądarkowe DSH / `ctx.slots`; render TUI pi, `ctx.ui`, skróty klawiszowe, flagi CLI.
- **Adaptery modeli rejestrowane w hoście**: ten, kto dodaje providera, czyni to wobec własnego hosta — w tym cały sens „nie przekładania" — providery pi opadają w pi, adaptery DSH opadają w DSH.
- **Bundle DSH bez niczego do wywołania**: czysta nakładka interfejsu albo ustawień nie ma narzędzi do przekazania. Preview mówi to wprost, zamiast zmyślać zdolności.
- **Pakiety wymagające interaktywnego hosta**: przekazane wywołanie może streamować postęp, ale nie może wyrzucić selektora po tamtej stronie.

## Trwałość

Rejestracje od razu spadają do bieżącej sesji. Każdy host przy wczytywaniu wtyczki odświeża z `~/.dsh-pi-bridge/bridges.json` to, co sam zanotował, dlatego instalacja oيزwiającej przeżywa restart — sprawdzono: restart sesji DSH i narzędzia mostu okazują się na miejscu. Odświeżanie czyta tylko cache: start hosta nigdy nie czeka na pobranie po sieci; gdy cache wyczyszczono, most melduje niedostępność, zamiast wisieć. Restart czyni nowe narzędzia widocznymi też dla innych klientów (GUI webowe, drugie okno), bo ci składają listę narzędzi przy starcie. Wyłącza się ustawieniem `restoreOnLoad: false` w konfiguracji bundle'a.

Do ustawień żadnego hosta nie piszemy. `bridge_remove` cofa zapomnienie mostu i usuwa jego katalog builda; narzędzia już zarejestrowane w działającym procesie pozostają do restartu, bo ciche wyrejestrowanie stanu hosta jest gorsze niż pozostawienie ich widocznymi.

## Bezpieczeństwo

Pakiet mostowy **uruchamia kod z Twoimi uprawnieniami, po tej stronie, gdzie działa**. Każdy host rozszerzeń stawia to samo żądanie; ten pakiet przyszedł z innego ekosystemu i jego przeglądu Marketplace nie przechodził, więc żądanie obowiązuje tym mocniej. Przeczytaj najpierw jego kod źródłowy; `preview` tylko rozrywa i rozgląda się, niczego nie rejestrując.

Przekazywanie nie jest sandboxem: pakiet działa z pełnym zaufaniem własnego hosta — dlatego to działa. Punkt końcowy loopback binduje się wyłącznie do 127.0.0.1, otwiera się tylko przy ustawionym `DSH_PI_BRIDGE_DSH_SERVE`, a klient odrzuca adresy spoza loopback. Ktokolwiek sięgnie do portu, zdoła wywołać każde narzędzie wczytane przez sesję. Otwieraj port tylko wtedy, gdy trzeba.

## Rozplanowanie

```text
index.js                wejście DSH: name / inject / apply(ctx), czyli narzędzia pi_*
extensions/index.js     wejście pi: fabryka default(pi), narzędzia i komendy dsh_*
skills/dsh-pi-bridge/   SKILL.md, wspólne dla obu hostów
cordis.patch.yml        montowanie bundle'a DSH (cel włącznika na panelu wtyczek)
daemon/run.mjs          nadzorowany proces pi; loopbackowy front swych narzędzi
daemon/bootstrap.js     ładowany prawdziwym ładowarzem rozszerzeń pi do środka pi
src/proxy.js            strona DSH: uruchomić/użyć ponownie demona, przekazywać wywołania
src/dsh-loader.js       strona DSH: wczytywać bundle w czasie biegu przeciw żywemu scope
src/serve.js            strona DSH: punkt końcowy loopback dla drugiego hosta
src/dsh-host-client.js  strona pi: rozmażyć z żywą sesją DSH
src/resolve.js          źródła npm / git / url / lokalne do cache, z instalacją zależności
src/load.js             układanie drzewa zwierciadlanego, kompilacja TS, instalacja prawdziwych zależności
src/manifest.js         rozpoznawanie hosta po keywords, manifeście i kształcie katalogu
src/capture.js          nagrane podkładki-hosty dla obu konwencji wejścia
src/schema.js           dwukierunkowe przetwarzanie schematów parametrów
src/capabilities.js     znormalizowany model zdolności; projekcja wyników
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          odświeżanie zanotowanych mostów przy starcie hosta
src/stubs.js            przeskanowanie importów i wytwarzanie zaślepek dla preview
src/tar.js              czytelnik gzipped-tar, bez zależności
src/transpile.js        TypeScript -> ESM, przez node:module
```

`index.js` importuje tylko wbudowania `node:` plus własny pakiet i deklaruje `inject: ["tools"]` — jedną usługę, której potrzebuje. Skille i ustawienia obsługiwane są przez `ctx.inject` po kontroli zdolności; profil bez rejestru skill po prostu nie montuje skilla, zamiast upadać na starcie.

## Licencja

MIT
