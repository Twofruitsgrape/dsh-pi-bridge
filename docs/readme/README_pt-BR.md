[English](../../README.md) · **Português (Brasil)**

# dsh-pi-bridge

Um plugin, dois anfitriões. Instalado no pi, permite que o pi use plugins do DeepSeek Harness; instalado no DSH, permite que o DSH use plugins do pi. Nenhuma das partes executa o código da outra "traduzindo-o": o plugin sempre roda dentro do próprio host dele — onde a API do host é real — e a outra parte apenas repassa as chamadas.

```text
# pi
pi install npm:dsh-pi-bridge            # ou: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

Reinicie o host depois de instalar. As duas palavras-chave (`pi-package` e `dsh-plugin`) estão declaradas, então o marketplace de cada ecossistema encontra este pacote.

## O que você ganha em cada host

| | pi | DSH |
|---|---|---|
| Usar plugins do outro lado | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| Gerenciar o que foi ponteado | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | a mesma `SKILL.md`, montada via registro de skills |

Ambos os lados usam a mesma gramática de fontes: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, URL de repositório ou caminho local — exatamente os formatos que cada host já aceita.

Um trecho de uma sessão real, ao pé da letra: boot real do DSH, modelo real, instalação de um pacote pi de fato publicado.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # uma ferramenta vinda do pacote pi
  -> resultados de busca ao vivo, coletados pelo próprio provider do pacote com a configuração dele
```

## Como funciona

### Plugins do pi entrando no DSH: um processo pi supervisionado

O `pi_install` materializa o pacote no cache da ponte, instala as dependências reais dele e depois o carrega dentro de um processo pi (`pi --mode rpc`) supervisionado pela ponte. Cada item que o pi reporta vira uma ferramenta no DSH; as chamadas são repassadas ao pi e devolvem o resultado calculado por ele. O diretório `SKILL.md` é montado como dados via `ctx.skills`. O pacote enxerga o `registerTool`, o `registerProvider`, o registro de modelos e as credenciais de provider reais do pi — um pacote que acessa rede ou modelos se comporta exatamente como nas mãos de um usuário do pi.

Este desenho substituiu a abordagem anterior: reexecutar os registros no DSH e apoiar-se em imports pontificados com stubs. Aquela versão passava em todos os testes com mocks e desabava na frente de pacotes reais — porque um import com stub é uma ferramenta que não funciona. Repassar para o host nativo é a única forma que pode continuar sendo honesta com os resultados.

### Plugins do DSH entrando no pi: uma sessão DSH viva

Um bundle do DSH requer `ctx.tools`, `ctx.llm` reais e o registro de skills, então o `dsh_install` pede à sessão DSH viva que ela mesma carregue o bundle. O obstáculo está aqui: o bundle instalado pelo gerenciador de plugins é um symlink sob o `node_modules` do perfil, e os especificadores crus `@deepseek-ai/*` não se resolvem — a medição reportou `MODULE_NOT_FOUND`. É justamente isso que o `src/dsh-loader.js` conserta: ele reescreve esses especificadores para URLs dos módulos que o build em execução traz (pacotes reais, não stubs); imports relativos, `node:` e de terceiros ficam como estão. O bundle se registra junto ao host, e o pi recebe uma ferramenta repassada para cada capability.

O endpoint fica fechado por padrão; um boot comum do DSH não abre porta alguma:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # lado do DSH
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # lado do pi
```

Só se liga ao 127.0.0.1, e o cliente recusa endereços que não sejam de loopback. Quando nenhum DSH vivo está alcançável, o `dsh_install` diz isso com franqueza e recua para o modo de tradução, em vez de fingir que o repasse deu certo.

### Quando nenhum dos hosts está alcançável

A ponte mesmo assim resolve a fonte, compila TypeScript (`stripTypeScriptTypes` do `node:module`, sem baixar toolchain) e captura o que o pacote registraria, por isso o `preview` funciona em qualquer lugar. Reexecutar registros no outro host fica reservado a cenários no mesmo host e a bundles cujo payload inteiro é dado: um bundle do DSH que é só um diretório de skills não tem nada chamável, mas o skill em si atravessa. Ambos os hosts implementam a [especificação de Agent Skills](https://agentskills.io/specification).

### Formas de parâmetros e resultados

As ferramentas do DSH carregam uma tabela de especificação de propriedades (`{ text: { type: "string", required: true } }`) que o `@deepseek-ai/dsh-tools` compila para JSON Schema; as ferramentas do pi carregam JSON Schema diretamente (TypeBox). O `src/schema.js` converte nos dois sentidos, e os resultados passam pela mesma projeção: o `{ content: [{ type: "text" }] }` do pi e o `{ ok, result }` do DSH se traduzem mutuamente. O host valida esquemas no ato do registro, e o subconjunto aceito é mais estreito que o rascunho do JSON Schema — uma marca `required` no nó de propriedade, ou um array `required` no nível de objeto no esquema de saída, derrubam a ativação do plugin inteiro. Essas regras vêm de medições contra os hosts instalados; a suíte de testes as carrega como asserções.

## Verificado — e como

Cada item abaixo foi medido contra hosts reais, não contra dublês:

- Boot real do DSH, modelo real, instalação do `npm:pi-web-access` e chamada a `web_web_search` através dele (os resultados são coletados pelo próprio provider do pacote)
- Uma sessão real do DSH carrega um bundle com import cru de `@deepseek-ai/dsh-tools`, e depois um processo separado chama as ferramentas dele via loopback
- Esta ponte roda a própria entrada DSH pelo mesmo mecanismo que um bundle estranho encontra dentro do pi

Cada um deles pegou um bug que nenhum dublê pega: um arquivo esquecido no manifest publicado; um esquema de saída que o host rejeita e que deixa o plugin mudo e desativado; `process.execPath` apontando para o aplicativo em vez do node dentro do processo do host; o reporte de zero capabilities na reinstalação porque o daemon já tinha carregado o pacote; um scope que proíbe atribuição de propriedades; um server handler rodando fora da fiber que sobe o serviço; um host que recusa nomes de ferramenta duplicados.

```bash
npm test                # todas as suítes offline
npm run test:offline    # pipeline + entradas de host dos dois lados
npm run test:proxy      # daemon, repasse pelo lado do DSH e pelo lado do pi
npm run test:host       # contra o build do DSH instalado (veja a nota)
npm run test:network    # pacotes publicados de verdade, vindos de npm e GitHub
npm run test:live       # o de cima contra um pi de fato em execução
```

O `test:host` lê o `@deepseek-ai/dsh-tools` do próprio host por dentro do asar do host instalado; só um fs com patch de Electron consegue isso, então rode-o dentro do processo do host. Em node comum ele reporta SKIP claramente, sem insinuar que o host nos recusou.

As suítes offline montam as fixtures à mão — uma extensão pi em TypeScript usando o builder TypeBox, um bundle do DSH usando `defineTool`, um bundle com import cru do pacote do host — e fazem o pipeline inteiro correr contra stubs gravados, e executam de verdade as ferramentas que saem pela ponte. Algumas regras vivem como asserções estáticas, porque só se revelam num boot real: as formas de esquema que o host aceita; os arquivos obrigatórios na publicação; o fato de um bundle sob análise não poder erguer processos nem agarrar portas.

## O que não atravessa

A ponte informa esses casos com honestidade, em vez de falhar em silêncio:

- **UI do host**: páginas de navegador do DSH / `ctx.slots`; o renderizador TUI do pi, `ctx.ui`, atalhos de teclado, flags de CLI.
- **Adaptadores de modelo registrados no host**: quem adiciona um provider o faz diante do próprio host — é exatamente esse o sentido de "não traduzir" — os providers do pi se assentam no pi, os adapter do DSH se assentam no DSH.
- **Bundles do DSH sem nada chamável**: um overlay puramente de interface ou de configurações não tem ferramentas a repassar. O preview diz isso abertamente, em vez de inventar capabilities.
- **Pacotes que exigem um host interativo**: chamadas repassadas podem transmitir progresso em fluxo, mas não podem fazer saltar um seletor do outro lado.

## Persistência

Os registros caem de imediato na sessão atual. Cada host, ao carregar o plugin, recarrega de `~/.dsh-pi-bridge/bridges.json` aquilo que ele mesmo anotou, por isso uma instalação sobrevive ao reinício — verificado reiniciando uma sessão do DSH e achando as ferramentas da ponte no lugar. A recarga só lê o cache: um boot de host nunca espera download pela rede; se o cache foi limpo, a ponte reporta indisponibilidade em vez de pender. O reinício também torna as novas ferramentas visíveis para outros clientes (GUI web, segunda janela), porque estes montam a lista de ferramentas na partida. Desativa-se com `restoreOnLoad: false` na configuração do bundle.

Não escrevemos nas configurações de host nenhum. O `bridge_remove` esquece uma ponte e limpa o diretório de build dela; as ferramentas já registradas no processo em funcionamento permanecem até o reinício, porque desregistrar em silêncio o estado do host é pior do que deixá-las visíveis.

## Segurança

Um pacote ponteado **executa código com as suas permissões, no host onde ele roda**. Qualquer host de extensões impõe a mesma exigência; este pacote vem de outro ecossistema e não passou pela revisão do seu marketplace, então a exigência vale ainda mais. Leia primeiro o código-fonte dele; o `preview` só analisa e inspeciona, não registra nada.

O repasse não é uma sandbox: o pacote roda com a confiança plena do próprio host dele — é por isso que funciona. O endpoint de loopback liga-se só ao 127.0.0.1, abre-se apenas se `DSH_PI_BRIDGE_DSH_SERVE` estiver definido, e o cliente recusa endereços que não sejam de loopback. Quem chegar àquela porta pode invocar qualquer ferramenta carregada pela sessão. Abra a porta apenas quando precisar.

## Leiaute

```text
index.js                entrada do DSH: name / inject / apply(ctx), ou seja, as ferramentas pi_*
extensions/index.js     entrada do pi: fábrica default(pi), ferramentas e comandos dsh_*
skills/dsh-pi-bridge/   SKILL.md, compartilhado pelos dois hosts
cordis.patch.yml        montagem do bundle do DSH (alvo da alavanca no painel de plugins)
daemon/run.mjs          o processo pi supervisionado; frente de loopback de suas ferramentas
daemon/bootstrap.js     é carregado pelo carregador de extensões real do pi, por dentro do pi
src/proxy.js            lado do DSH: iniciar/reutilizar o daemon, repassar chamadas
src/dsh-loader.js       lado do DSH: carregar o bundle em tempo de execução contra o scope vivo
src/serve.js            lado do DSH: endpoint de loopback para o outro host
src/dsh-host-client.js  lado do pi: conversar com a sessão DSH viva
src/resolve.js          fontes npm / git / url / locais para o cache, com instalação de dependências
src/load.js             montar a árvore espelho, compilar TS, instalar dependências reais
src/manifest.js         reconhecimento do host por keywords, manifest e forma do diretório
src/capture.js          hosts dublês gravados para as duas convenções de entrada
src/schema.js           conversão bidirecional de esquemas de parâmetros
src/capabilities.js     modelo de capabilities normalizado; projeção de resultados
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          recarregar as pontes anotadas no boot do host
src/stubs.js            varredura de imports e produção de stubs para o preview
src/tar.js              leitor de gzipped-tar, sem dependências
src/transpile.js        TypeScript -> ESM, via node:module
```

O `index.js` importa só built-ins do `node:` mais o próprio pacote e declara `inject: ["tools"]` — o único serviço de que precisa. Skills e configurações se alcançam via `ctx.inject` após a checagem de capability; um perfil sem registro de skills simplesmente não monta o skill, em vez de fracassar no boot.

## Licença

MIT
