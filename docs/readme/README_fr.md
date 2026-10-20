[English](../../README.md) · **Français**

# dsh-pi-bridge

Un plugin, deux hôtes. Installé dans pi, il permet à pi d'utiliser des plugins DeepSeek Harness ; installé dans DSH, il permet à DSH d'utiliser des plugins pi. Aucun des deux côtés n'exécute le code de l'autre en le « traduisant » : le plugin tourne toujours dans son propre hôte — là où l'API de l'hôte est réelle — et l'autre côté se contente de relayer les appels.

```text
# pi
pi install npm:dsh-pi-bridge            # ou : pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

Redémarrez l'hôte après l'installation. Les deux mots-clés (`pi-package` et `dsh-plugin`) sont déclarés, donc le marketplace de chaque écosystème trouve ce paquet.

## Ce que vous obtenez dans chaque hôte

| | pi | DSH |
|---|---|---|
| Utiliser les plugins de l'autre côté | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| Gérer le ponté | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | la même `SKILL.md`, montée via le registre de skills |

Les deux côtés utilisent la même syntaxe de source : `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, URL de dépôt ou chemin local — exactement les formats que chaque hôte accepte déjà.

Un extrait de session réelle, mot pour mot : démarrage réel de DSH, modèle réel, installation d'un paquet pi réellement publié.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # un outil issu du paquet pi
  -> résultats de recherche en direct, récupérés par le provider du paquet avec sa propre configuration
```

## Comment ça marche

### Les plugins pi dans DSH : un processus pi supervisé

`pi_install` matérialise le paquet dans le cache du pont, installe ses vraies dépendances, puis le charge dans un processus pi (`pi --mode rpc`) supervisé par le pont. Chaque enregistrement rapporté par pi devient un outil dans DSH ; les appels sont relayés vers pi et renvoient le résultat calculé par pi. Le répertoire `SKILL.md` est monté en tant que données via `ctx.skills`. Le paquet voit le vrai `registerTool` de pi, son `registerProvider`, son registre de modèles et ses identifiants de provider — un paquet qui touche au réseau ou aux modèles se comporte exactement comme entre les mains d'un utilisateur de pi.

 Cette conception a remplacé l'approche antérieure qui rejouait les enregistrements dans DSH en s'appuyant sur des imports stubés. Cette version passait tous les tests à mocks et s'écroulait face à de vrais paquets — car un import stubé est un outil qui ne fonctionne pas. Relayer vers l'hôte natif est la seule forme qui peut rester honnête envers les résultats.

### Les plugins DSH dans pi : une session DSH vivante

Un bundle DSH réclame du vrai `ctx.tools`, du vrai `ctx.llm` et le registre de skills, donc `dsh_install` demande à la session DSH vivante de charger elle-même le bundle. L'obstacle : le bundle installé par le gestionnaire de plugins est un symlink sous le `node_modules` du profil, et les spécificateurs nus `@deepseek-ai/*` ne se résolvent pas — le test a rapporté `MODULE_NOT_FOUND`. C'est justement ce que fait `src/dsh-loader.js` : réécrire ces spécificateurs vers les URL des modules qu'apporte la build en cours d'exécution (de vrais paquets, pas des stubs) ; les imports relatifs, `node:` et tiers restent inchangés. Le bundle s'enregistre auprès de l'hôte, et pi reçoit un outil relayé pour chaque capacité.

L'endpoint est fermé par défaut ; un lancement ordinaire de DSH n'ouvre aucun port :

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # côté DSH
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # côté pi
```

Il se lie uniquement à 127.0.0.1 et le client refuse les adresses non-loopback. Quand aucun DSH vivant n'est joignable, `dsh_install` le dit franchement et retombe en mode traduction, au lieu de prétendre que le relais a réussi.

### Quand aucun hôtes n'est joignable

Le pont résout quand même la source, compile le TypeScript (`stripTypeScriptTypes` de `node:module`, sans télécharger une toolchain) et capture ce que le paquet enregistrerait, donc `preview` fonctionne partout. Le rejeu d'enregistrements dans l'autre hôte reste réservé aux scénarios du même hôte et aux bundles dont tout le payload est de la donnée — un bundle DSH qui n'est qu'un répertoire de skills n'a rien d'invoquable, mais le skill lui-même passe. Les deux hôtes implémentent la [spécification Agent Skills](https://agentskills.io/specification).

### Formes des paramètres et des résultats

Les outils DSH portent une table de spécification de propriétés (`{ text: { type: "string", required: true } }`) que `@deepseek-ai/dsh-tools` compile en JSON Schema ; les outils pi portent directement du JSON Schema (TypeBox). `src/schema.js` convertit dans les deux sens, et les résultats passent par la même projection : le `{ content: [{ type: "text" }] }` de pi et le `{ ok, result }` de DSH se convertissent mutuellement. L'hôte valide les schémas à l'enregistrement, et le sous-ensemble accepté est plus étroit que le brouillon de JSON Schema — un marqueur `required` sur le nœud de propriété, ou un tableau `required` au niveau objet dans le schéma de sortie, font échouer l'activation du plugin entier. Ces règles viennent de mesures contre les hôtes installés ; la suite de tests les porte en assertions.

## Vérifié — et comment

Chacun des points suivants a été mesuré contre de vrais hôtes, pas contre des mocks :

- Démarrage réel de DSH, modèle réel, installation de `npm:pi-web-access` et appel de `web_web_search` à travers lui (les résultats sont récupérés par le provider propre du paquet)
- Une vraie session DSH charge un bundle à import nu de `@deepseek-ai/dsh-tools`, puis un processus séparé invoque ses outils via loopback
- Ce pont exécute sa propre entrée DSH via le même mécanisme qu'un bundle étranger rencontre dans pi

Chacun d'eux a attrapé un bug qu'aucun mock n'attrape : un fichier oublié du manifeste publié ; un schéma de sortie que l'hôte rejette et qui laisse le plugin silencieusement inactif ; `process.execPath` qui, dans le processus de l'hôte, pointe l'application et non node ; le signalement de zéro capacité à la réinstallation parce que le démon avait déjà chargé le paquet ; un scope qui interdit l'affectation de propriétés ; un server handler exécuté hors de la fibre qui démarre le service ; un hôte qui refuse les noms d'outils dupliqués.

```bash
npm test                # toutes les suites hors ligne
npm run test:offline    # pipeline + entrées d'hôte des deux côtés
npm run test:proxy      # démon, relais côté DSH et côté pi
npm run test:host       # contre la build DSH installée (voir la note)
npm run test:network    # de vrais paquets publiés, venus de npm et GitHub
npm run test:live       # ce qui précède contre un pi réellement en cours
```

`test:host` lit le `@deepseek-ai/dsh-tools` propre à l'hôte depuis l'intérieur de l'asar de l'hôte installé ; seul un fs patché Electron peut le faire, exécutez-le donc dans le processus de l'hôte. Sous node ordinaire, il signale SKIP explicitement, sans laisser entendre que l'hôte nous a refusés.

Les suites hors ligne construisent leurs fixtures à la main — une extension pi en TypeScript avec le builder TypeBox, un bundle DSH avec `defineTool`, un bundle à import nu du paquet de l'hôte — puis font tourner toute la pipeline contre des stubs enregistrés, et exécutent réellement les outils sortis par le pont. Certaines règles vivent en assertions statiques, parce qu'elles ne se révèlent qu'au démarrage réel : les formes de schémas que l'hôte accepte ; les fichiers qui doivent être publiés ; le fait qu'un bundle en cours d'analyse ne doit ni lancer de processus ni lier de ports.

## Ce qui ne traverse pas

Le pont signale honnêtement ces cas au lieu d'échouer en silence :

- **UI de l'hôte** : page navigateur de DSH / `ctx.slots` ; le rendu TUI de pi, `ctx.ui`, raccourcis clavier, drapeaux CLI.
- **Adaptateurs de modèles enregistrés dans l'hôte** : qui ajoute un provider le fait auprès de son propre hôte — c'est exactement le sens de « ne pas traduire » — les providers de pi tombent dans pi, les adapter de DSH tombent dans DSH.
- **Bundles DSH sans rien d'invoquable** : un pur overlay d'UI ou de settings n'a pas d'outils à relayer. Preview le dit clairement, au lieu d'inventer des capacités.
- **Paquets exigeant un hôte interactif** : les appels relayés peuvent streamer la progression, mais ne peuvent pas faire surgir un picker de l'autre côté.

## Persistance

Les enregistrements tombent immédiatement dans la session courante. Chaque hôte, au chargement du plugin, recharge depuis `~/.dsh-pi-bridge/bridges.json` ce qu'il a lui-même noté, donc une installation survit à un redémarrage — vérifié en redémarrant une session DSH et en y retrouvant les outils du pont. Le rechargement ne lit que le cache : un démarrage d'hôte n'attend jamais un téléchargement réseau ; si le cache a été vidé, le pont signale l'indisponibilité au lieu de rester suspendu. Le redémarrage rend aussi les nouveaux outils visibles aux autres clients (GUI web, seconde fenêtre), parce qu'ils assemblent leur liste d'outils au démarrage. Désactivable via `restoreOnLoad: false` dans la configuration du bundle.

On n'écrit pas dans les réglages d'aucun hôte. `bridge_remove` oublie un pont et supprime son répertoire de build ; les outils déjà enregistrés dans le processus tournant restent jusqu'au redémarrage, car désenregistrer silencieusement l'état de l'hôte est pire que les laisser visibles.

## Sécurité

Un paquet ponté **exécute du code avec vos droits, dans l'hôte où il tourne**. Tout hôte d'extensions impose la même exigence ; ce paquet vient d'un autre écosystème et n'a pas traversé la revue de son marketplace, l'exigence vaut donc plus encore. Lisez d'abord son code source ; `preview` n'analyse et n'inspecte que, sans rien enregistrer.

Le relais n'est pas une sandbox : le paquet tourne avec la confiance pleine de son propre hôte, et c'est pourquoi il fonctionne. L'endpoint loopback ne se lie qu'à 127.0.0.1, ne s'ouvre que si `DSH_PI_BRIDGE_DSH_SERVE` est défini, et le client refuse les adresses non-loopback. Quiconque atteint ce port peut invoquer les outils chargés par la session. N'ouvrez le port qu'en cas de besoin.

## Disposition

```text
index.js                entrée DSH : name / inject / apply(ctx), c'est-à-dire les outils pi_*
extensions/index.js     entrée pi : fabrique default(pi), outils et commandes dsh_*
skills/dsh-pi-bridge/   SKILL.md, partagé par les deux hôtes
cordis.patch.yml        montage de bundle DSH (cible de l'interrupteur du panneau plugins)
daemon/run.mjs          le processus pi supervisé ; façade loopback de ses outils
daemon/bootstrap.js     chargé par le vrai chargeur d'extensions de pi, à l'intérieur de pi
src/proxy.js            côté DSH : démarrer/réutiliser le démon, relayer les appels
src/dsh-loader.js       côté DSH : charger le bundle à l'exécution contre le scope vivant
src/serve.js            côté DSH : endpoint loopback pour l'autre hôte
src/dsh-host-client.js  côté pi : parler à la session DSH vivante
src/resolve.js          sources npm / git / url / locales vers le cache, avec installation des dépendances
src/load.js             construire l'arbre miroir, compiler le TS, installer les vraies dépendances
src/manifest.js         reconnaissance de l'hôte par keywords, manifeste et forme du répertoire
src/capture.js          hôtes stub enregistrés pour les deux conventions d'entrée
src/schema.js           conversion bidirectionnelle des schémas de paramètres
src/capabilities.js     modèle de capacités normalisé ; projection des résultats
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          recharger les ponts notés au démarrage de l'hôte
src/stubs.js            scan des imports et production de stubs pour preview
src/tar.js              lecteur de tar gzippé, sans dépendances
src/transpile.js        TypeScript -> ESM, via node:module
```

`index.js` n'importe que les built-ins de `node:` plus le paquet lui-même, et déclare `inject: ["tools"]` — le seul service dont il a besoin. Skills et réglages sont joignables via `ctx.inject` après contrôle de capacité ; un profil sans registre de skills ne monte simplement pas le skill, au lieu de faire échouer le démarrage.

## Licence

MIT
