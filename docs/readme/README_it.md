[English](../../README.md) · **Italiano**

# dsh-pi-bridge

Un plugin, due host. Installato in pi, permette a pi di usare i plugin di DeepSeek Harness; installato in DSH, permette a DSH di usare i plugin di pi. Nessuna delle due parti esegue il codice dell'altra "traducendolo": il plugin gira sempre dentro il proprio host — dove l'API dell'host è reale — e l'altra parte si limita a inoltrare le chiamate.

```text
# pi
pi install npm:dsh-pi-bridge            # oppure: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

Riavvia l'host dopo l'installazione. Entrambe le parole chiave (`pi-package` e `dsh-plugin`) sono dichiarate, quindi il marketplace di ciascun ecosistema trova questo pacchetto.

## Cosa ottieni in ciascun host

| | pi | DSH |
|---|---|---|
| Usare i plugin dell'altra parte | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| Gestire ciò che è stato pontificato (bridged) | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | la stessa `SKILL.md`, montata tramite il registro delle skill |

Le due parti usano la stessa grammatica delle fonti: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, URL del repository o percorso locale — esattamente i formati che ciascun host già accetta.

Un estratto di una sessione reale, alla lettera: avvio reale di DSH, modello reale, installazione di un pacchetto pi davvero pubblicato.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # uno strumento che arriva dal pacchetto pi
  -> risultati di ricerca dal vivo, raccolti dal provider del pacchetto stesso con la sua configurazione
```

## Come funziona

### I plugin di pi entrano in DSH: un processo pi supervisionato

`pi_install` materializza il pacchetto nella cache del ponte, ne installa le dipendenze reali, poi lo carica dentro un processo pi (`pi --mode rpc`) supervisionato dal ponte. Ogni voce che pi riporta diventa uno strumento in DSH; le chiamate vengono inoltrate a pi e restituiscono il risultato calcolato da pi. La directory `SKILL.md` viene montata come dati tramite `ctx.skills`. Il pacchetto vede il vero `registerTool` di pi, il suo `registerProvider`, il registro dei modelli e le credenziali reali dei provider — un pacchetto che tocca la rete o i modelli si comporta esattamente come nelle mani di un utente di pi.

Questo design ha sostituito l'approccio anteriore: riassaggiare le registrazioni in DSH e appoggiarsi a import girati con stub. Quella versione passava tutti i test con mock e crollava davanti ai pacchetti veri — perché un import ridotto a stub è uno strumento che non funziona. Inoltrare verso l'host nativo è l'unica forma che può restare onesta di fronte ai risultati.

### I plugin di DSH entrano in pi: una sessione DSH viva

Un bundle DSH richiede un `ctx.tools`, un `ctx.llm` veri e il registro delle skill, quindi `dsh_install` chiede alla sessione DSH viva di caricare lei stessa il bundle. L'ostacolo sta qui: il bundle installato dal gestore dei plugin è un symlink sotto il `node_modules` del profilo, e gli specificatori nudi `@deepseek-ai/*` non si risolvono — la misura ha segnalato `MODULE_NOT_FOUND`. Proprio a questo serve `src/dsh-loader.js`: riscrive quegli specificatori negli URL dei moduli che porta con sé la build in esecuzione (pacchetti veri, non stub); gli import relativi, `node:` e quelli di terze parti restano intatti. Il bundle va a registrarsi all'host, e pi riceve uno strumento inoltrato per ogni capability.

L'endpoint è chiuso per impostazione predefinita; un avvio normale di DSH non apre alcuna porta:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # lato DSH
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # lato pi
```

Si lega solo a 127.0.0.1, e il client rifiuta indirizzi non-loopback. Quando non si raggiunge un DSH vivo, `dsh_install` lo dice francamente e rientra in modalità traduzione, invece di fingere che l'inoltro sia riuscito.

### Quando nessun host è raggiungibile

Il ponte comunque risolve la sorgente, compila TypeScript (`stripTypeScriptTypes` di `node:module`, senza scaricare una toolchain) e raccoglie cosa registrerebbe il pacchetto, quindi `preview` funziona ovunque. Il riassunto delle registrazioni nell'altro host resta riservato agli scenari nello stesso host e ai bundle il cui payload è interamente dati — un bundle DSH puro indice di skill non ha nulla di invocabile, ma il skill in sé passa. Entrambi gli host implementano la [specifica Agent Skills](https://agentskills.io/specification).

### Forme dei parametri e dei risultati

Gli strumenti DSH portano una tabella di specifica delle proprietà (`{ text: { type: "string", required: true } }`) che `@deepseek-ai/dsh-tools` compila in JSON Schema; gli strumenti pi portano JSON Schema direttamente (TypeBox). `src/schema.js` converte in ambedue le direzioni, e i risultati passano per la stessa proiezione: il `{ content: [{ type: "text" }] }` di pi e il `{ ok, result }` di DSH si traducono a vicenda. L'host valida gli schemi al momento della registrazione, e il sottoinsieme accettato è più stretto della bozza JSON Schema — un marcatore `required` sul nodo proprietà, o un'array `required` a livello oggetto nello schema di uscita, fanno collassare l'attivazione dell'intero plugin. Queste regole arrivano da misure contro gli host installati; la suite di test le porta come asserzioni.

## Verificato — e come

Ciascun punto qui sotto è stato misurato contro host veri, non contro manichini:

- Avvio reale di DSH, modello reale, installazione di `npm:pi-web-access` e chiamata di `web_web_search` attraverso di esso (i risultati li raccoglie il provider del pacchetto stesso)
- Una sessione reale di DSH carica un bundle con import nudo di `@deepseek-ai/dsh-tools`, poi un processo separato invoca i suoi strumenti via loopback
- Questo ponte esegue la propria entrata DSH con lo stesso meccanismo che un bundle estraneo incontra dentro pi

Ciascuno di essi ha preso un bug che nessun manichino prende: un file dimenticato dal manifesto pubblicato; uno schema di uscita che l'host respinge e che lascia il plugin silenziosamente inerte; `process.execPath` che nel processo dell'host punta all'applicazione e non a node; il report di zero capability alla reinstallazione perché il demone aveva già caricato il pacchetto; uno scope che vieta l'assegnazione di proprietà; un server handler che gira fuori dalla fiber che accende il servizio; un host che respinge i nomi di strumenti duplicati.

```bash
npm test                # tutte le suite offline
npm run test:offline    # pipeline + entrate host di ambedua i lati
npm run test:proxy      # demone, inoltro lato DSH e lato pi
npm run test:host       # contro la build DSH installata (vedi nota)
npm run test:network    # pacchetti davvero pubblicati, da npm e GitHub
npm run test:live       # quanto sopra contro un pi davvero in esecuzione
```

`test:host` legge il `@deepseek-ai/dsh-tools` dell'host stesso dall'interno dell'asar dell'host installato; ci riesce solo un fs con patch Electron, quindi esegui dentro il processo host. Con node normale segnala esplicitamente SKIP, senza lasciar intendere che l'host ci abbia respinto.

Le suite offline costruiscono le proprie fixture a mano — un'estensione pi in TypeScript col builder TypeBox, un bundle DSH con `defineTool`, un bundle con import nudo del pacchetto host — e fanno girare l'intera pipeline contro stub registrati, quindi eseguono davvero gli strumenti che escono dal ponte. Alcune regole vivono come asserzioni statiche, perché si rivelano solo all'avvio reale: le forme di schema che l'host accetta; i file che vanno pubblicati; il fatto che un bundle in analisi non debba né levare processi né legare porte.

## Cosa non attraversa

Il ponte segnala questi casi con onestà, invece di fallire in silenzio:

- **UI dell'host**: pagine browser di DSH / `ctx.slots`; il renderer TUI di pi, `ctx.ui`, scorciatoie da tastiera, opzioni CLI.
- **Adattatori di modelli registrati presso l'host**: chi aggiunge un provider lo fa verso il proprio host — è esattamente questo il senso di "non tradurre" — i provider di pi cadono in pi, i adapter di DSH cadono in DSH.
- **Bundle DSH senza nulla di invocabile**: un overlay puramente di interfaccia o di impostazioni non ha strumenti da inoltrare. Preview lo dichiara chiaramente, invece di inventare capability.
- **Pacchetti che esigono un host interattivo**: le chiamate inoltrate possono trasmettere il progresso in flusso, ma non possono far spuntare un selettore dall'altra parte.

## Persistenza

Le registrazioni cadono subito nella sessione corrente. Ciascun host, al caricamento del plugin, ricarica da `~/.dsh-pi-bridge/bridges.json` ciò che ha annotato da sé, così un'installazione sopravvive al riavvio — verificato riavviando una sessione DSH e ritrovando gli strumenti del ponte al loro posto. Il ricaricamento legge solo la cache: un avvio dell'host non aspetta mai un download di rete; se la cache è stata svuotata, il ponte segnala indisponibilità invece di restare appeso. Il riavvio rende i nuovi strumenti visibili anche agli altri clienti (GUI web, seconda finestra), perché assemblano la propria lista strumenti all'avvio. Disattivabile con `restoreOnLoad: false` nella configurazione del bundle.

Non scriviamo nelle impostazioni di nessun host. `bridge_remove` dimentica un ponte e cancella la sua directory di build; gli strumenti già registrati nel processo in funzione restano fino al riavvio, perché dereglare in silenzio lo Stato dell'host è peggio che lasciarli visibili.

## Sicurezza

Un pacchetto ponteato **esegue codice con i tuoi permessi, nell'host dove gira**. Ogni host di estensioni impone la stessa pretesa; questo pacchetto viene da un altro ecosistema e non ha attraversato la revisione del suo marketplace, dunque la pretesa vale ancora di più. Leggi prima il suo codice sorgente; `preview` solo analizza e ispeziona, non registra nulla.

L'inoltro non è una sandbox: il pacchetto gira con la piena fiducia del proprio host, ed è per questo che funziona. L'endpoint loopback si lega solo a 127.0.0.1, si apre solo se `DSH_PI_BRIDGE_DSH_SERVE` è impostato, e il client rifiuta indirizzi non locali. Chiunque raggiunga quella porta può invocare ogni strumento caricato dalla sessione. Apri la porta solo se serve.

## Disposizione

```text
index.js                entrata DSH: name / inject / apply(ctx), cioè gli strumenti pi_*
extensions/index.js     entrata pi: fabbrica default(pi), strumenti e comandi dsh_*
skills/dsh-pi-bridge/   SKILL.md, condiviso dai due host
cordis.patch.yml        montaggio del bundle DSH (bersaglio del pulsante nel pannello plugin)
daemon/run.mjs          il processo pi supervisionato; fronte loopback dei suoi strumenti
daemon/bootstrap.js     caricato dal vero caricatore di estensioni di pi, dentro pi
src/proxy.js            lato DSH: avviare/riusare il demone, inoltrare le chiamate
src/dsh-loader.js       lato DSH: caricare il bundle a tempo di esecuzione contro lo scope vivo
src/serve.js            lato DSH: endpoint loopback per l'altro host
src/dsh-host-client.js  lato pi: parlare con la sessione DSH viva
src/resolve.js          fonti npm / git / url / locali verso la cache, con installazione delle dipendenze
src/load.js             costruire l'albero specchio, compilare TS, installare dipendenze reali
src/manifest.js         riconoscere l'host da keywords, manifesto e forma della directory
src/capture.js          host-manichino registrati per ambedue le convenzioni d'entrata
src/schema.js           conversione bidirezionale degli schemi dei parametri
src/capabilities.js     modello di capability normalizzato; proiezione dei risultati
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          ricaricare i ponti annotati all'avvio dell'host
src/stubs.js            scansione degli import e fabbricazione di stub per preview
src/tar.js              lettore gzipped-tar, senza dipendenze
src/transpile.js        TypeScript -> ESM, via node:module
```

`index.js` importa solo i built-in di `node:` più il pacchetto stesso e dichiara `inject: ["tools"]` — l'unico servizio di cui ha bisogno. Skill e impostazioni si raggiungono via `ctx.inject` dopo il controllo di capability; un profilo senza registro di skill semplicemente non monta la skill, invece di far crollare l'avvio.

## Licenza

MIT
