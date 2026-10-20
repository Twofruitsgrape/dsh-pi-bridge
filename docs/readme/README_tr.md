[English](../../README.md) · **Türkçe**

# dsh-pi-bridge

Tek bir eklenti, iki konak. pi'ye kurulduğunda pi'nin DeepSeek Harness eklentilerini kullanmasını sağlar; DSH'ye kurulduğunda DSH'nin pi eklentilerini kullanmasını sağlar. Her iki taraf da karşı tarafın kodunu "çevirerek" çalıştırmaz: eklenti daima kendi ev sahibi içinde çalışır — çünkü oradaki konak API'si gerçek halidir — diğer taraf yalnızca çağrıları aktarır.

```text
# pi
pi install npm:dsh-pi-bridge            # ya da: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

Kurulumdan sonra konakları yeniden başlatın. Her iki anahtar kelime de (`pi-package` ve `dsh-plugin`) beyan edildiği için her ekosistemin pazaryeri bu paketi buluyor.

## Her konakta ne elde edersiniz

| | pi | DSH |
|---|---|---|
| Karşı tarafın eklentilerini kullanmak | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| Köprüleneni yönetmek | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | aynı `SKILL.md`, skill kayıt defteri üzerinden bağlanır |

İki taraf da aynı kaynak söz dizimini kullanır: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, depo URL'si veya yerel yol — her konağın zaten kabul ettiği biçimlerin ta kendisi.

Gerçek bir oturumdan bir kesit, harfi harfine: gerçek DSH başlangıcı, gerçek model, gerçekten yayımlanmış bir pi paketinin kurulması.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # pi paketinden gelen bir araç
  -> canlı arama sonuçları, paketin kendi provider yapılandırmasıyla alındı
```

## Nasıl çalışır

### pi eklentileri DSH'ye girerken: denetimli pi süreci

@`pi_install` paketi köprünün önbelleğine maddeler, gerçek bağımlılıklarını kurar, sonra köprünün denetlediği bir pi süreci içinde (`pi --mode rpc`) yükler. pi'nin bildirdiği her kayıt DSH'de bir araca dönüşür; çağrılar pi'ye iletilir ve pi'nin hesapladığı sonucu döndürür. `SKILL.md` dizini veri olarak `ctx.skills` üzerinden bağlanır. Paket, pi'nin gerçek `registerTool`'unu, `registerProvider`'ını, model kayıt defterini ve provider kimlik bilgilerini görür — ağa ya da modellere erişen bir paket, pi kullanıcısının elindekiyle tamamen aynı davranır.

Bu tasarım, kayıtları DSH'ye geri oynatan ve stub'lanmış import'lara yaslanan önceki yaklaşımın yerini aldı. O sürüm tüm sahte (mock) testlerini geçti ama gerçek paketlerin karşısında çöktü — çünkü stub'lanmış bir bağımlılık, çalışmayan bir araçtan ibarettir. Sonuçlara karşı dürüst kalabilen tek biçim, yerli konak'a yönlendirmedir.

### DSH eklentileri pi'ye girerken: yaşayan bir DSH oturumu

Bir DSH bundle'ı gerçek `ctx.tools`, gerçek `ctx.llm` ve skill kayıt defterini ister; bu yüzden `dsh_install` yaşayan DSH oturumunun kendisinden bundle'ı yüklemesini ister. Engel şurada: eklenti yöneticisinin kurduğu bundle, profilin `node_modules` altında bir simlink'tir ve çıplak `@deepseek-ai/*` belirticileri çözülmez — ölçümde `MODULE_NOT_FOUND` raporlandı. İşte tam da `src/dsh-loader.js` bunu yapar: o belirticileri, çalışan yapının getirdiği modüllerin URL'lerine (gerçek paketler; stub değil) yazar; göreli import'lar, `node:` ve üçüncü parti import'lar olduğu gibi kalır. Bundle konak'a kaydolur ve pi her yeteneğe karşılık bir aktarma aracı alır.

Uç nokta varsayılan olarak kapalıdır; sıradan bir DSH başlangıcı hiçbir port açmaz:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # DSH tarafı
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # pi tarafı
```

Yalnızca 127.0.0.1'e bağlanır ve istemci loopback olmayan adresleri reddeder. Yaşayan bir DSH'ye ulaşılamadığında `dsh_install` bunu dürüstçe söyler ve çeviri moduna döner; aktarmanın başarılı olduğu numarası yapmaz.

### İki konak da ulaşılamadığında

Köprü yine de kaynağı çözer, TypeScript'i derler (`node:module`'un `stripTypeScriptTypes`'ı, araç zinciri indirmeden) ve paketin ne kaydedeceğini yakalar; bu yüzden `preview` her yerde çalışır. Kayıtların diğer konak'a geri oynatılması, aynı konak senaryolarına ve tüm yükü veri olan bundle'lara bırakılır — saf skill dizini olan bir DSH bundle'ının çağrılabilir bir şeyi yoktur ama skill'in kendisi geçer. İki konak da [Agent Skills belirtimini](https://agentskills.io/specification) uygular.

### Parametre ve sonuç biçimleri

DSH araçları bir özellik şartnamesi tablosu taşır (`{ text: { type: "string", required: true } }`), `@deepseek-ai/dsh-tools` bunu JSON Schema'ya derler; pi araçları JSON Schema'yı doğrudan taşır (TypeBox). `src/schema.js` iki yönde dönüştürür ve sonuçlar da aynı izdüşümden geçer: pi'nin `{ content: [{ type: "text" }] }`'i ile DSH'nin `{ ok, result }`'ı birbirine çevrilir. Konak, kaydolma anında şemaları doğrular ve kabul ettiği alt küme taslak JSON Schema'dan dardır — özellik düğümündeki `required` işareti ya da çıkış şemasındaki nesne düzeyi `required` dizisi, eklentinin tamamının etkinleşmesini düşürür. Bu kurallar kurulu konaklara karşı yapılan ölçümlerden gelir; test takımı bunları iddialar olarak taşır.

## Doğrulandı — ve nasıl

Aşağıdakilerin her biri, uydulara değil gerçek konaklara karşı ölçüldü:

- Gerçek DSH başlangıcı, gerçek model, `npm:pi-web-access` kurulumu ve üzerinden `web_web_search` çağrısı (sonuçları paketin kendi provider'ı toplar)
- Gerçek bir DSH oturumu çıplak `@deepseek-ai/dsh-tools` import'lu bir bundle yükler, ardından ayrı bir süreç loopback üzerinden araçlarını çağırır
- Bu köprü, kendi DSH girişini yabancı bir bundle'ın pi'de karşılaştığı mekanizmayla çalıştırır

Her biri, hiçbir uydunun yakalayamayacağı bir hata yakaladı: yayımlanan manifest'te unutulan bir dosya; konakın reddettiği ve eklentiyi sessizce etkisiz bırakan çıkış şeması; konak sürecinde `process.execPath`'in node yerine uygulamayı göstermesi; yeniden kurulumda daemon paketi çoktan yüklediği için sıfır yetenek bildirmesi; özellik atamasını yasaklayan bir scope; servisi başlatan fiber dışında çalışan bir server handler; yinelenen araç adlarını reddeden konak.

```bash
npm test                # tüm çevrimdışı takımlar
npm run test:offline    # hat + iki tarafın konak girişleri
npm run test:proxy      # daemon, DSH tarafı ve pi tarafı aktarma
npm run test:host       # kurulu DSH yapısına karşı (nota bakın)
npm run test:network    # npm ve GitHub'dan gelen gerçek yayımlı paketler
npm run test:live       # yukarıdakiler gerçekte çalışan bir pi'ye karşı
```

`test:host`, konağın kendi `@deepseek-ai/dsh-tools`'unu kurulu konağın asar'ının içinden okur; buna yalnızca Electron yamalı fs erişir, bu yüzden konak sürecinin içinde çalıştırın. Sıradan node altında SKIP'i açıkça bildirir; konağın bizi reddettiği imasını taşımaz.

Çevrimdışı takımlar topraklarını elle diker — TypeBox builder'la yazılmış bir TypeScript pi eklentisi, `defineTool` kullanan bir DSH bundle'ı, çıplak konak paketi import'lu bir bundle — sonra borunun tamamını kayda alınmış uydulara karşı koşturur ve köprüden çıkan araçları gerçekten çalıştırır. Bazı kurallar statik iddia olarak yaşar, çünkü yalnızca gerçek başlangıçta kendini gösterir: konağın kabul ettiği şema biçimleri; yayımlanması zorunlu dosyalar; analiz edilen bir bundle'ın süreç başlatmaması ve port bağlamaması gerektiği.

## Karşıya geçmeyen şeyler

Köprü bu durumları sessizce başarısız bırakmak yerine dürüstçe bildirir:

- **Konak arayüzü**: DSH tarayıcı sayfaları / `ctx.slots`; pi'nin TUI işleyicisi, `ctx.ui`, klavye kısayolları, CLI bayrakları.
- **Konak'a kaydolan model bağdaştırıcıları**: provider ekleyen paket bunu kendi konağına karşı yapar — "çevirmemek" işte bu demektir — pi'nin provider'ları pi'ye düşer, DSH'nin adapter'ları DSH'ye düşer.
- **Çağrılabilir hiçbir şeyi olmayan DSH bundle'ları**: saf bir arayüz ya da ayar katmanının aktarılacak aracı yoktur. preview bunu dürüstçe söyler, yetenek uydurmaz.
- **Etkileşimli konak isteyen paketler**: aktarılan çağrı ilerlemeyi akışla bildirebilir ama öbür tarafta bir seçici açamaz.

## Kalıcılık

Kayıtlar anında güncel oturuma düşer. Her konak, eklenti yüklendiği anda `~/.dsh-pi-bridge/bridges.json`'dan kendi tuttuğunu yeniden okur; bu yüzden bir kurulum yeniden başlatmayı aşar — bir DSH oturumu yeniden başlatılıp köprü araçlarının yerinde bulunduğu görülerek doğrulandı. Tekrar okuma yalnızca önbelleği okur: konak başlangıcı asla ağ indirmesini beklemez; önbellek silinmişse köprü asılı kalmak yerine ulaşılamazlığını bildirir. Yeniden başlatma, yeni araçları diğer istemcilerin de görmesini sağlar (web GUI, ikinci pencere), çünkü onlar araç listesini başlangıçta kurar. Bundle ayarlarındaki `restoreOnLoad: false` ile kapatılır.

Hiçbir konağın ayarlarına yazarız. `bridge_remove` bir köprüyü unutur ve yapım dizinini siler; çalışan sürece kaydolmuş araçlar yeniden başlatmaya kadar kalır — konak durumunu sessizce kayıt dışı bırakmak, onları görünür bırakmaktan daha kötüdür.

## Güvenlik

Köprülenen bir paket, **çalıştığı tarafta, sizin yetkilerinizle kod çalıştırır**. Her eklenti konağı aynı şartı koyar; bu paket başka bir ekosistemden gelir ve o pazaryerinin incelemesinden geçmemiştir, o yüzden şart daha da geçerlidir. Önce kaynak kodunu okuyun; `preview` yalnızca çözer ve inceleme yapar, hiçbir şey kaydetmez.

Aktarma bir sandbox değildir: paket kendi konağının tüm güveniyle çalışır; bu yüzden işe yarar. Loopback uç nokta yalnızca 127.0.0.1'e bağlanır, `DSH_PI_BRIDGE_DSH_SERVE` belirlenmedikçe açılmaz ve istemci loopback olmayan adresleri reddeder. Bu porta erişebilen herkes, oturumun yüklediği araçları çağırabilir. Gerekmedikçe açmayın.

## Dizilim

```text
index.js                DSH girişi: name / inject / apply(ctx), yani pi_* araçları
extensions/index.js     pi girişi: default(pi) fabrikası, dsh_* araçları ve komutlar
skills/dsh-pi-bridge/   SKILL.md, iki konakça paylaşılır
cordis.patch.yml        DSH bundle bağlama (eklenti panelindeki anahtarın hedefi)
daemon/run.mjs          denetimli pi süreci; araçlarının loopback cephesi
daemon/bootstrap.js     pi'nin gerçek eklenti yükleyicisiyle pi'nin içinden yüklenir
src/proxy.js            DSH tarafı: daemon başlat/yeniden kullan, çağrı aktar
src/dsh-loader.js       DSH tarafı: bundle'ı çalışma anında yaşayan scope'a karşı yükle
src/serve.js            DSH tarafı: diğer konak için loopback uç nokta
src/dsh-host-client.js  pi tarafı: yaşayan DSH oturumuyla konuş
src/resolve.js          npm / git / url / yerel kaynakları bağımlılık kurulumuyla önbelleğe al
src/load.js             ayna ağacı kur, TS derle, gerçek bağımlılıkları kur
src/manifest.js         anahtar kelimelerden, manifest'ten ve dizin biçiminden konak tanıma
src/capture.js          iki giriş kuralına ait kayıtlı uydu konaklar
src/schema.js           parametre şemalarını iki yönde dönüştür
src/capabilities.js     normalleştirilmiş yetenek modeli; sonuçların izdüşümü
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          konağın başlangıcında kayıtlı köprüleri yeniden yükle
src/stubs.js            preview için import taraması ve stub üretimi
src/tar.js              gzipped-tar okuyucu, bağımlılıksız
src/transpile.js        TypeScript -> ESM, node:module üzerinden
```

`index.js` yalnızca `node:` gömülülerini ve kendi paketini import eder ve `inject: ["tools"]` beyan eder — ihtiyaç duyduğu tek servis. Skill'ler ve ayarlar, yetenek kontrolünden geçmiş `ctx.inject` üzerinden erişilir; skill kayıt defteri içermeyen bir profil yalnızca skill'i bağlamaz, başlangıçta düşmez.

## Lisans

MIT
