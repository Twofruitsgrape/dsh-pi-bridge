[English](../../README.md) · **Español**

# dsh-pi-bridge

Un plugin, dos hosts. Instalado en pi, permite que pi use plugins de DeepSeek Harness; instalado en DSH, permite que DSH use plugins de pi. Ningún lado ejecuta el código del otro "traduciéndolo": el plugin siempre corre dentro de su propio host —donde la API del host es real— y el otro lado solo reenvía las llamadas.

```text
# pi
pi install npm:dsh-pi-bridge            # o bien: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

Reinicia el host tras instalar. Ambas palabras clave (`pi-package` y `dsh-plugin`) están declaradas, así que el marketplace de cada ecosistema encuentra este paquete.

## Qué obtienes en cada host

| | pi | DSH |
|---|---|---|
| Usar plugins del otro lado | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| Gestionar lo puenteado | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | la misma `SKILL.md`, montada vía el registro de skills |

Ambos lados usan la misma sintaxis de fuentes: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, URL de repositorio o ruta local —exactamente los formatos que cada host ya acepta.

Un extracto de una sesión real, tal como ocurrió: arranque real de DSH, modelo real, instalación de un paquete pi realmente publicado.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # una herramienta que viene del paquete pi
  -> resultados de búsqueda en vivo, obtenidos por el propio provider del paquete con su configuración
```

## Cómo funciona

### Plugins de pi dentro de DSH: un proceso pi supervisado

`pi_install` materializa el paquete en la caché del puente, instala sus dependencias reales y luego lo carga dentro de un proceso pi (`pi --mode rpc`) supervisado por el puente. Cada registro que pi reporta se convierte en una herramienta de DSH, y las llamadas se reenvían a pi y devuelven el resultado calculado por pi. El directorio `SKILL.md` se monta como datos vía `ctx.skills`. El paquete ve el `registerTool`, `registerProvider`, el registro de modelos y las credenciales de provider reales de pi —un paquete que accede a la red o a modelos se comporta exactamente igual que en manos de un usuario de pi.

Este diseño reemplazó al enfoque anterior de reproducir los registros en DSH y depender de imports apuntados con stubs. Esa versión pasaba todos los tests con mocks y fallaba estrepitosamente ante paquetes reales, porque un import stubbeado es una herramienta que no funciona. Reenviar hacia el host nativo es la única forma que puede seguir siendo honesta con los resultados.

### Plugins de DSH dentro de pi: una sesión DSH viva

Un bundle de DSH requiere un `ctx.tools`, un `ctx.llm` reales y el registro de skills, así que `dsh_install` pide a la sesión DSH viva que ella misma cargue el bundle. El obstáculo: el bundle instalado por el gestor de plugins es un symlink bajo el `node_modules` del perfil, y los especificadores desnudos `@deepseek-ai/*` no se resuelven —lo comprobado y reportado fue `MODULE_NOT_FOUND`. Justamente, `src/dsh-loader.js` reescribe esos especificadores a URLs de los módulos que aporta el build en ejecución (paquetes reales, no stubs); los imports relativos, `node:` y los de terceros quedan tal cual. El bundle se registra ante el host y pi recibe una herramienta reenviada por cada capability.

El endpoint está cerrado por defecto; un arranque normal de DSH no abre ningún puerto:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # lado DSH
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # lado pi
```

Se vincula solo a 127.0.0.1 y el cliente rechaza direcciones que no sean loopback. Cuando no hay un DSH vivo alcanzable, `dsh_install` lo dice con franqueza y retrocede al modo de traducción, en lugar de fingir que el reenvío tuvo éxito.

### Cuando ninguno de los dos hosts está accesible

El puente igualmente resuelve la fuente, compila TypeScript (`stripTypeScriptTypes` de `node:module`, sin necesidad de descargar una toolchain) y captura lo que el paquete registraría, así que `preview` funciona en cualquier parte. Repercutir registros en el otro host queda reservado para escenarios del mismo host y para bundles cuyo payload son datos por completo: un bundle de DSH que es un directorio puro de skills no tiene nada invocable, pero el skill en sí sí cruza. Ambos hosts implementan la [especificación de Agent Skills](https://agentskills.io/specification).

### Formas de parámetros y resultados

Las herramientas de DSH llevan una tabla de especificación de propiedades (`{ text: { type: "string", required: true } }`) que `@deepseek-ai/dsh-tools` compila a JSON Schema; las herramientas de pi llevan JSON Schema directamente (TypeBox). `src/schema.js` convierte en ambas direcciones, y los resultados pasan por la misma proyección: el `{ content: [{ type: "text" }] }` de pi y el `{ ok, result }` de DSH se traducen mutuamente. El host valida los esquemas en el registro, y el subconjunto que acepta es más estrecho que el borrador de JSON Schema —un marcador `required` sobre el nodo de propiedad, o un array `required` a nivel de objeto en el esquema de salida, hacen que la activación de todo el plugin falle. Estas reglas provienen de mediciones contra los hosts instalados; la suite de tests las lleva como aserciones.

## Verificado — y cómo

Cada punto que sigue se midió contra hosts reales, no contra mocks:

- Arranque real de DSH, modelo real, instalación de `npm:pi-web-access` y llamada de `web_web_search` a través de él (los resultados los recoge el propio provider del paquete)
- Una sesión real de DSH carga un bundle con import desnudo de `@deepseek-ai/dsh-tools`, y luego un proceso aparte invoca sus herramientas a través de loopback
- Este puente ejecuta su propia entrada DSH mediante el mismo mecanismo con el que un bundle extranjero se encuentra dentro de pi

Cada uno de ellos atrapó un bug que ningún mock atrapa: un archivo que el manifiesto publicado olvidó; un esquema de salida que el host rechaza y que deja al plugin muda-/silenciosamente inactivo; `process.execPath` que en el proceso del host apunta a la aplicación y no a node; el reporte de cero capabilities al reinstalar porque el daemon ya había cargado el paquete; un scope que prohíbe la asignación de propiedades; un server handler que corre fuera de la fiber que arranca el servicio; un host que rechaza nombres de herramientas duplicados.

```bash
npm test                # todas las suites offline
npm run test:offline    # pipeline + entradas de host de ambos lados
npm run test:proxy      # daemon, reenvío por el lado DSH y por el lado pi
npm run test:host       # contra el build de DSH instalado (ver nota)
npm run test:network    # paquetes publicados reales, de npm y GitHub
npm run test:live       # lo anterior contra un pi realmente en ejecución
```

`test:host` lee el `@deepseek-ai/dsh-tools` del propio host desde dentro del asar del host instalado; solo un fs parcheado por Electron puede hacerlo, así que ejecútalo dentro del proceso del host. Con node normal reporta SKIP de forma explícita, sin insinuar que el host nos rechazó.

Las suites offline construyen sus fixtures a mano: una extensión pi en TypeScript con el builder de TypeBox, un bundle de DSH con `defineTool`, un bundle con import desnudo del paquete del host —y hacen correr toda la pipeline contra stubs grabados, y ejecutan de verdad las herramientas que salen por el puente. Algunas reglas viven como aserciones estáticas, porque solo se revelan en un arranque real: las formas de esquema que el host acepta; los archivos que hay que publicar; que un bundle en análisis no debe lanzar procesos ni atar puertos.

## Lo que no cruza

El puente reporta estos casos con honestidad en vez de fallar en silencio:

- **UI del host**: páginas de navegador de DSH / `ctx.slots`; el renderizador TUI de pi, `ctx.ui`, atajos de teclado, flags de CLI.
- **Adaptadores de modelo registrados en el host**: quien añade un provider lo hace ante su propio host —y eso es exactamente el sentido de "no traducir": los providers de caen en pi, los adapter de DSH caen en DSH.
- **Bundles de DSH sin nada invocable**: un overlay puro de UI o de settings no tiene herramientas que reenviar. Preview lo dice claramente, en vez de inventar capabilities.
- **Paquetes que exigen un host interactivo**: las llamadas reenviadas pueden transmitir progreso en flujo, pero no pueden hacer saltar un selector del otro lado.

## Persistencia

Los registros caen de inmediato en la sesión actual. Cada host, al cargar el plugin, recarga de `~/.dsh-pi-bridge/bridges.json` lo que él mismo apuntó, así que una instalación sobrevive a un reinicio —verificado reiniciando una sesión DSH y encontrando las herramientas del puente en su lugar. La recarga solo lee la caché: el arranque del host nunca espera una descarga por red; si la caché fue vaciada, el puente reporta indisponibilidad en lugar de colgarse. El reinicio también hace visible el nuevo conjunto de herramientas para otros clientes (GUI web, segunda ventana), porque arman su lista de herramientas al arrancar. Se puede desactivar con `restoreOnLoad: false` en la configuración del bundle.

No se escribe en la configuración de ningún host. `bridge_remove` olvida un puente y borra su directorio de build; las herramientas ya registradas en el proceso en marcha permanecen hasta el reinicio, porque desregistrar en silencio el estado del host es peor que dejarlas visibles.

## Seguridad

Un paquete puenteado **ejecuta código con tus permisos, en el host donde corre**. Todo host de extensiones exige lo mismo; este paquete viene de otro ecosistema y no pasó por la revisión de su marketplace, así que la exigencia es aún mayor. Lee primero su código fuente; `preview` solo analiza e inspecciona, no registra nada.

El reenvío no es una sandbox: el paquete corre con la confianza plena de su propio host, y por eso funciona. El endpoint de loopback se vincula solo a 127.0.0.1, solo se abre si `DSH_PI_BRIDGE_DSH_SERVE` está definido, y el cliente rechaza direcciones que no sean loopback. Cualquiera que alcance ese puerto puede invocar las herramientas cargadas por la sesión. Abre el puerto solo si lo necesitas.

## Diseño

```text
index.js                entrada DSH: name / inject / apply(ctx), es decir, las herramientas pi_*
extensions/index.js     entrada pi: fábrica default(pi), herramientas y comandos dsh_*
skills/dsh-pi-bridge/   SKILL.md, compartido por ambos hosts
cordis.patch.yml        montaje de bundle DSH (objetivo del interruptor en el panel de plugins)
daemon/run.mjs          el proceso pi supervisado; frente loopback de sus herramientas
daemon/bootstrap.js     lo carga pi real, vía su cargador de extensiones, dentro de pi
src/proxy.js            lado DSH: arrancar/reutilizar el daemon, reenviar llamadas
src/dsh-loader.js       lado DSH: cargar el bundle en tiempo de ejecución contra el scope vivo
src/serve.js            lado DSH: endpoint de loopback para el otro host
src/dsh-host-client.js  lado pi: hablar con la sesión DSH viva
src/resolve.js          fuentes npm / git / url / locales hacia la caché, con instalación de dependencias
src/load.js             construir el árbol espejo, compilar TS, instalar dependencias reales
src/manifest.js         reconocimiento del host por keywords, manifiesto y forma del directorio
src/capture.js          hosts stub grabados para ambas convenciones de entrada
src/schema.js           conversión bidireccional de esquemas de parámetros
src/capabilities.js     modelo de capabilities normalizado; proyección de resultados
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          recargar puentes anotados al arrancar el host
src/stubs.js            escaneo de imports y generación de stubs para preview
src/tar.js              lector de tar comprimido gzipped, sin dependencias
src/transpile.js        TypeScript -> ESM, vía node:module
```

`index.js` solo importa built-ins de `node:` más el propio paquete, y declara `inject: ["tools"]` —el único servicio que necesita. Skills y settings se alcanzan vía `ctx.inject` tras la comprobación de capabilities; un perfil sin registro de skills simplemente no monta el skill, en lugar de fallar el arranque.

## Licencia

MIT
