[English](../../README.md) · **Deutsch**

# dsh-pi-bridge

Ein Plugin, zwei Hosts. In pi installiert, lässt es pi DeepSeek-Harness-Plugins nutzen; in DSH installiert, lässt es DSH pi-Plugins nutzen. Keine der beiden Seiten „übersetzt" den Code der anderen, um ihn laufen zu lassen: Ein Plugin läuft immer in seinem eigenen Host – dort ist die Host-API echt – die andere Seite leitet nur Aufrufe weiter.

```text
# pi
pi install npm:dsh-pi-bridge            # oder: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

Starten Sie den Host nach der Installation neu. Beide Schlüsselwörter (`pi-package` und `dsh-plugin`) sind deklariert, daher findet jedes Ökosystem-Marketplace dieses Paket.

## Was Sie in jedem Host bekommen

| | pi | DSH |
|---|---|---|
| Plugins der anderen Seite nutzen | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| Überbrücktes verwalten | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | dieselbe `SKILL.md`, über die Skill-Registry eingebunden |

Beide Seiten verwenden dieselbe Quell-Syntax: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, Repository-URL oder lokaler Pfad – genau die Formate, die jeder Host ohnehin akzeptiert.

Ein Ausschnitt aus einer echten Sitzung, wortgetreu: echter DSH-Start, echtes Modell, Installation eines tatsächlich veröffentlichten pi-Pakets.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # ein Tool aus dem pi-Paket
  -> Live-Suchergebnisse, abgerufen mit der eigenen Provider-Konfiguration des Pakets
```

## Wie es funktioniert

### pi-Plugins in DSH: ein beaufsichtigter pi-Prozess

`pi_install` materialisiert das Paket in den Cache der Brücke, installiert seine echten Abhängigkeiten und lädt es dann in einem von der Brücke beaufsichtigten pi-Prozess (`pi --mode rpc`). Jeder Eintrag, den pi meldet, wird zu einem Tool in DSH; Aufrufe werden an pi weitergeleitet und liefern das von pi berechnete Ergebnis zurück. Das `SKILL.md`-Verzeichnis wird als Daten über `ctx.skills` eingebunden. Das Paket sieht pis echte `registerTool`, `registerProvider`, Modell-Registry und Provider-Zugangsdaten – ein Paket, das aufs Netz oder Modelle zugreift, verhält sich exakt so wie in der Hand eines pi-Benutzers.

Dieser Entwurf löste den früheren Ansatz ab, Registrierungen in DSH zurückzuspielen und sich auf gestubbte Imports zu verlassen. Diese Version bestand alle Mock-Tests und scheiterte kläglich an echten Paketen – denn ein gestubbter Import ist ein nicht funktionierendes Tool. Die Weiterleitung in den nativen Host ist die einzige Form, die den Ergebnissen gegenüber ehrlich bleiben kann.

### DSH-Plugins in pi: eine lebendige DSH-Sitzung

Ein DSH-Bundle braucht echtes `ctx.tools`, echtes `ctx.llm` und die Skill-Registry, daher bittet `dsh_install` die lebendige DSH-Sitzung selbst, das Bundle zu laden. Die Hürde: Das vom Plugin-Manager installierte Bundle ist ein Symlink unter dem `node_modules` des Profils, und nackte `@deepseek-ai/*`-Spezifizierer lösen sich nicht auf – im Test wurde `MODULE_NOT_FOUND` gemeldet. Genau diese Spezifizierer schreibt `src/dsh-loader.js` in URLs der Module um, die der laufende Build mitbringt (echte Pakete, keine Stubs); relative Imports, `node:`- und Drittanbieter-Imports bleiben unangetastet. Das Bundle registriert sich beim Host, und pi erhält für jede Capability ein weitergeleitetes Tool.

Der Endpunkt ist standardmäßig geschlossen; ein gewöhnlicher DSH-Start öffnet keinen Port:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # DSH-Seite
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # pi-Seite
```

Gebunden wird nur an 127.0.0.1; der Client lehnt Nicht-Loopback-Adressen ab. Ist kein lebendiges DSH erreichbar, sagt `dsh_install` das wahrheitsgemäß und fällt in den Übersetzungsmodus zurück – es tut nicht so, als wäre die Weiterleitung gelungen.

### Wenn kein Host erreichbar ist

Die Brücke löst die Quelle trotzdem auf, kompiliert TypeScript (`stripTypeScriptTypes` aus `node:module`, kein Download einer Toolchain nötig) und erfasst, was das Paket registrieren würde, daher funktioniert `preview` überall. Das Zurückspielen von Registrierungen in den anderen Host bleibt Szenarien im selben Host sowie Bundles vorbehalten, deren gesamter Payload Daten sind – ein reines Skill-Verzeichnis als DSH-Bundle hat nichts Aufrufbares, aber der Skill selbst kommt durch. Beide Hosts implementieren die [Agent-Skills-Spezifikation](https://agentskills.io/specification).

### Parameter- und Ergebnisformen

DSH-Tools tragen eine Eigenschaftsspezifikationstabelle (`{ text: { type: "string", required: true } }`), die `@deepseek-ai/dsh-tools` zu JSON Schema kompiliert; pi-Tools tragen direkt JSON Schema (TypeBox). `src/schema.js` konvertiert in beide Richtungen, Ergebnisse durchlaufen dieselbe Projektion: pis `{ content: [{ type: "text" }] }` und DSHs `{ ok, result }` gehen ineinander über. Der Host validiert Schemas bei der Registrierung, und die akzeptierte Teilmenge ist enger als draft JSON Schema – ein `required`-Marker auf dem Eigenschaftsknoten oder ein objektweites `required`-Array im Ausgabeschema lässt die Aktivierung des ganzen Plugins scheitern. Diese Regeln stammen aus Messungen an den installierten Hosts; das Test-Suite enthält sie als Assertions.

## Verifiziert – und wie

Jeder der folgenden Punkte wurde gegen echte Hosts gemessen, nicht gegen Mocks:

- Echter DSH-Start, echtes Modell, Installation von `npm:pi-web-access` und der Aufruf von `web_web_search` darüber (die Ergebnisse holt der eigene Provider des Pakets)
- Eine echte DSH-Sitzung lädt ein Bundle mit nacktem `@deepseek-ai/dsh-tools`-Import, danach ruft ein separater Prozess über Loopback seine Tools auf
- Diese Brücke führt ihren eigenen DSH-Eintrag über genau den Mechanismus aus, dem ein fremdes Bundle in pi begegnet

Jeder einzelne davon fing einen Bug, den kein Mock fängt: eine Datei, die der veröffentlichte Manifest vergessen hat; ein Ausgabeschema, das der Host ablehnt und das Plugin damit stumm deaktiviert; `process.execPath`, der im Host-Prozess auf die App statt auf node zeigt; die Meldung von null Capabilities bei der Neuinstallation, weil der Daemon das Paket schon geladen hat; ein Scope, der Eigenschaftszuweisungen verbietet; ein Server-Handler außerhalb der Faser des Dienststarts; ein Host, der doppelte Tool-Namen ablehnt.

```bash
npm test                # alle Offline-Suiten
npm run test:offline    # Pipeline + Host-Eintritte beider Seiten
npm run test:proxy      # Daemon, Weiterleitung auf DSH- und pi-Seite
npm run test:host       # gegen den installierten DSH-Build (siehe Hinweis)
npm run test:network    # echte veröffentlichte Pakete aus npm und GitHub
npm run test:live       # obiges gegen ein wirklich laufendes pi
```

`test:host` liest das eigene `@deepseek-ai/dsh-tools` des Hosts von innen aus dem asar des installierten Hosts – das kann nur ein fs mit Electron-Patch; führen Sie es im Host-Prozess aus. Unter gewöhnlichem node meldet es klar SKIP und deutet nicht an, der Host habe uns abgelehnt.

Die Offline-Suiten bauen ihre Fixtures von Hand – eine TypeScript-pi-Erweiterung mit dem TypeBox-Builder, ein DSH-Bundle mit `defineTool`, ein Bundle mit nacktem Host-Paket-Import – und lassen die gesamte Pipeline gegen aufgezeichnete Stubs laufen, dann führen sie die durch die Brücke entstandenen Tools wirklich aus. Manche Regeln stehen als statische Assertions, weil sie sich nur bei echtem Start zeigen: die Schemaformen, die der Host akzeptiert; die Dateien, die veröffentlicht werden müssen; dass ein zu analysierendes Bundle weder Prozesse startet noch Ports bindet.

## Was nicht hinübergeht

Die Brücke meldet diese Fälle ehrlich, statt still zu scheitern:

- **Host-UI**: DSH-Browserseite / `ctx.slots`, pis TUI-Renderer, `ctx.ui`, Tastenkürzel, CLI-Flags.
- **Beim Host registrierte Modelladapter**: Wer einen Provider hinzufügt, tut es gegenüber seinem eigenen Host – genau das ist der Sinn von „nicht übersetzen" – pis Provider landen in pi, DSHs Adapter in DSH.
- **DSH-Bundles ohne nichts Aufrufbares**: Ein reines UI- oder Settings-Overlay hat nichts, was sich weiterleiten ließe. Preview sagt das klar, statt Fähigkeiten zu erfinden.
- **Pakete, die einen interaktiven Host verlangen**: Weitergeleitete Aufrufe können Fortschritt streamen, aber keinen Picker auf der anderen Seite aufpoppen lassen.

## Persistenz

Registrierungen fallen sofort in die aktuelle Sitzung. Jeder Host lädt beim Laden des Plugins aus `~/.dsh-pi-bridge/bridges.json` zurück, was er selbst aufgezeichnet hat, deshalb überlebt eine Installation einen Neustart – geprüft durch Neustart einer DSH-Sitzung und das Auffinden der Brücken-Tools vor Ort. Das Nachladen liest nur den Cache: Ein Hoststart wartet nie auf einen Netzwerk-Download; ist der Cache geleert, meldet die Brücke „nicht verfügbar", statt zu hängen. Der Neustart macht die neuen Tools auch anderen Clients sichtbar (Web-GUI, zweites Fenster), weil diese ihre Tool-Liste beim Start zusammensetzen. Abschaltbar per `restoreOnLoad: false` in den Bundle-Einstellungen.

In die Einstellungen irgendeines Hosts wird nichts geschrieben. `bridge_remove` vergisst eine Brücke und löscht ihr Build-Verzeichnis; in den laufenden Prozess registrierte Tools bleiben bis zum Neustart, denn ein stiller Deregistrier-Vorgang auf dem Host-Zustand ist schlimmer, als sie sichtbar zu lassen.

## Sicherheit

Ein überbrücktes Paket **führt Code mit Ihren Rechten auf der Seite aus, wo es läuft**. Jeder Erweiterungs-Host stellt dieselbe Forderung; dieses Paket kommt aus einem anderen Ökosystem und hat die Prüfung dessen Marktplatzes nicht durchlaufen, daher gilt die Forderung umso mehr. Lesen Sie zuerst seinen Quellcode; `preview` analysiert und inspiziert nur und registriert nichts.

Die Weiterleitung ist keine Sandbox: Das Paket läuft mit dem vollen Vertrauen seines eigenen Hosts – genau deshalb funktioniert es. Der Loopback-Endpunkt bindet nur an 127.0.0.1, öffnet sich nur, wenn `DSH_PI_BRIDGE_DSH_SERVE` gesetzt ist, und der Client lehnt Nicht-Loopback-Adressen ab. Wer den Port erreicht, kann jedes von der Sitzung geladene Tool aufrufen. Also: nur öffnen, wenn nötig.

## Layout

```text
index.js                DSH-Eintritt: name / inject / apply(ctx), also die pi_*-Tools
extensions/index.js     pi-Eintritt: default(pi)-Fabrik, dsh_*-Tools und Befehle
skills/dsh-pi-bridge/   SKILL.md, von beiden Hosts geteilt
cordis.patch.yml        DSH-Bundle-Mount (Ziel des Toggles in der Plugin-Tafel)
daemon/run.mjs          der beaufsichtigte pi-Prozess; Loopback-Front seiner Tools
daemon/bootstrap.js     wird von pis echtem Erweiterungs-Loader in pi hineingeladen
src/proxy.js            DSH-Seite: Daemon starten/wiederverwenden, Aufrufe weiterleiten
src/dsh-loader.js       DSH-Seite: Bundle zur Laufzeit gegen den lebenden Scope laden
src/serve.js            DSH-Seite: Loopback-Endpunkt für den anderen Host
src/dsh-host-client.js  pi-Seite: mit der lebenden DSH-Sitzung sprechen
src/resolve.js          npm / git / url / lokal: Quelle in den Cache, inkl. Abhängigkeitsinstallation
src/load.js             Spiegelbaum bauen, TS kompilieren, echte Abhängigkeiten installieren
src/manifest.js         Host-Erkennung aus Schlüsselwörtern, Manifest und Verzeichnisform
src/capture.js          aufgezeichnete Stub-Hosts für beide Eintritts-Konventionen
src/schema.js           bidirektionale Umformung der Parameterschemas
src/capabilities.js     normalisiertes Capability-Modell; Projektion der Ergebnisse
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          aufgezeichnete Brücken beim Hoststart nachladen
src/stubs.js            Import-Scan und Stub-Erzeugung für preview
src/tar.js              gzipped-tar-Leser, ohne Abhängigkeiten
src/transpile.js        TypeScript -> ESM, über node:module
```

`index.js` importiert nur `node:`-Builtins plus das eigene Paket und deklariert `inject: ["tools"]` – den einzigen Dienst, den es braucht. Skills und Einstellungen sind über das capability-geprüfte `ctx.inject` erreichbar; ein Profil ohne Skill-Registry lässt den Skill einfach weg, statt beim Start zu scheitern.

## Lizenz

MIT
