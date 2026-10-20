[English](../../README.md) · **Bahasa Indonesia**

# dsh-pi-bridge

Satu plugin, dua inang. Dipasang di pi, ia memampukan pi memakai plugin DeepSeek Harness; dipasang di DSH, ia memampukan DSH memakai plugin pi. Tak ada pihak yang menjalankan kode pihak lain dengan "menerjemahkannya": plugin selalu berjalan di dalam host asalnya sendiri — di sana API host adalah bahau asli — pihak satunya hanya meneruskan panggilan.

```text
# pi
pi install npm:dsh-pi-bridge            # atau: pi install git:github.com/Twofruitsgrape/dsh-pi-bridge

# DSH
dsh plugin --profile <name> install github:Twofruitsgrape/dsh-pi-bridge
```

Mulai ulang host setelah memasang. Kedua kata kunci (`pi-package` dan `dsh-plugin`) telah dinyatakan, jadi pasar tiap ekosistem menemukan paket ini.

## Apa yang kamu dapat di tiap host

| | pi | DSH |
|---|---|---|
| Memakai plugin pihak lain | `dsh_install`, `dsh_preview`, `/dsh-install`, `/dsh-preview` | `pi_install`, `pi_preview` |
| Mengelola yang dijembatani | `/bridge-list`, `/bridge-remove` | `bridge_list`, `bridge_remove`, `bridge_status` |
| Skill | `skills/dsh-pi-bridge/SKILL.md` | `SKILL.md` yang sama, dikaitkan lewat registri skill |

Kedua pihak memakai tata sumber yang sama: `npm:<pkg>[@ver]`, `git:github.com/<owner>/<repo>[@ref]`, `github:<owner>/<repo>`, URL repositori atau path lokal — persis format yang tiap host terima sejak semula.

Potongan sesi nyata, kata per kata: start DSH sungguhan, model sungguhan, pemasangan paket pi yang sungguh dipublikasi.

```text
dsh> pi_install({ source: "npm:pi-web-access", prefix: "web" })
  bridged npm:pi-web-access as pi-web-access@0.41.0
    mode: package code runs natively inside a supervised pi process
    tools: web_web_search, web_source_check, web_fetch_content,
           web_get_search_content, web_web_enable
    pi slash commands registered in pi: /websearch, /curator, /google-account, /search

dsh> web_web_search({ query: "DeepSeek V4" })   # sebuah alat yang datang dari paket pi
  -> hasil pencarian hidup, dikutip oleh provider paket itu sendiri dengan konfigurasinya
```

## Cara bekerja

### Plugin pi masuk ke DSH: sebuah proses pi yang diawasi

`pi_install` mewujudkan paket ke cache jembatan, memasang dependensi sungguhannya, lalu memuatnya di dalam proses pi (`pi --mode rpc`) yang diawasi jembatan. Setiap butir yang dilaporkan pi menjadi satu alat di DSH; panggilan diteruskan ke pi dan mengembalikan hasil yang pi hitung. Direktori `SKILL.md` dikaitkan sebagai data lewat `ctx.skills`. Paket melihat `registerTool`, `registerProvider`, registri model, dan kredensial provider sungguhan milik pi — paket yang menyentuh jaringan atau model berperilaku persis seperti di tangan pengguna pi.

Desain ini menggantikan pendekatan semula: merekam ulang registrasi ke DSH dan bersandar pada import yang dipasangi stub. Versi itu lolos semua uji mock lalu runtuh di hadapan paket nyata — karena import yang di-stub adalah alat yang tak berfungsi. Meneruskan ke host natif adalah satu-satunya bentuk yang dapat tetap jujur pada hasil.

### Plugin DSH masuk ke pi: sesi DSH yang hidup

Bundle DSH menuntut `ctx.tools`, `ctx.llm` sungguhan dan registri skill, maka `dsh_install` meminta sesi DSH yang hidup memuat bundle itu sendiri. Halangan di sini: bundle yang dipasang pengelola plugin adalah symlink di bawah `node_modules` profil, dan penanda telanjang `@deepseek-ai/*` tak terurai — pengukuran melaporkan `MODULE_NOT_FOUND`. Tepat itulah pekerjaan `src/dsh-loader.js`: menulis ulang penanda itu ke URL modul yang dibawa build yang sedang berjalan (paket asli, bukan stub); import relatif, `node:`, dan import pihak ketiga turu saja. Bundle pergi mendaftar ke host, dan pi menerima satu alat terus-terusan untuk tiap capability.

Titik akhir tertutup secara bawaan; start DSH biasa tak membuka satu pun port:

```bash
DSH_PI_BRIDGE_DSH_SERVE=43191 dsh ...                    # sisi DSH
DSH_PI_BRIDGE_DSH_ENDPOINT=127.0.0.1:43191 pi ...        # sisi pi
```

Hanya terikat pada 127.0.0.1, dan klien menolak alamat non-loopback. Ketika sesi DSH yang hidup tak terjangkau, `dsh_install` mengatakannya dengan jujur dan mundur ke modo terjemahan, alih-alih pura-pura penerusan berhasil.

### Ketika tak ada host terjangkau

Jembatan tetap mengurai sumber, mengompilasi TypeScript (`stripTypeScriptTypes` dari `node:module`, tanpa mengunduh toolchain), dan menangkap apa yang akan diregistrasi paket, sehingga `preview` bekerja di mana saja. Merekam ulang registrasi ke host lain disisakan untuk skenario host yang sama dan untuk bundle yang seluruh muatannya adalah data — bundle DSH sepenuhnya direktori skill tak punya apa-apa untuk dipanggil, tapi skill itu sendiri lewat. Kedua host mengimplementasi [spesifikasi Agent Skills](https://agentskills.io/specification).

### Ragam parameter dan hasil

Alat DSH membawa tabel spesifikasi properti (`{ text: { type: "string", required: true } }`) yang dikompilasi `@deepseek-ai/dsh-tools` menjadi JSON Schema; alat pi membawa JSON Schema langsung (TypeBox). `src/schema.js` mengonversi dua arah, dan hasil melewati proyeksi sama: `{ content: [{ type: "text" }] }` milik pi dan `{ ok, result }` milik DSH saling diterjemahkan. Host memvalidasi skema saat registrasi, dan subtaksimu yang diterima lebih sempit dari draf JSON Schema — penanda `required` pada simpul properti, atau larik `required` setingkat objek pada skema keluaran, menjatuhkan aktivasi seluruh plugin. Aturan-aturan itu datang dari pengukuran terhadap host yang terpasang; rang uji membawanya sebagai asersi.

## Terverifikasi — dan bagaimana

Setiap butir di bawah diukur terhadap host sungguhan, bukan tenden:

- Start DSH sungguhan, model sungguhan, pemasangan `npm:pi-web-access` dan pemanggilan `web_web_search` lewatnya (hasilnya dikutip oleh provider paket itu sendiri)
- Sesi DSH sungguhan memuat bundle ber-import telanjang `@deepseek-ai/dsh-tools`, lalu proses terpisah memanggil alat-alatnya lewat loopback
- Jembatan ini menjalankan pintu masuk DSH miliknya sendiri dengan mekanisme persis yang dijumpai bundle asing di dalam pi

Masing-masingnya menangkap kutu yang tak tertangkap tendangan mana pun: berkas yang lupa dimuat manifest publikasi; skema keluaran yang ditolak sehingga plugin diam lumpuh; `process.execPath` menunjuk aplikasi alih-alih node di dalam proses host; laporan nol capability saat pasang ulang karena daemon sudah memuat paket; scope yang melarang pengisian properti; server handler yang berjalan di luar fiber penyalakan layanan; host yang menolak nama alat ganda.

```bash
npm test                # semua rang uji lintas tak tersambung
npm run test:offline    # pipeline + pintu masuk host dua piha
npm run test:proxy      # daemon, penerusan sisi DSH dan sisi pi
npm run test:host       # terhadap build DSH yang terpasang (lihat catatan)
npm run test:network    # paket benar-benar dipublikasi, dari npm dan GitHub
npm run test:live       # hal di atas terhadap pi yang sungguh berjalan
```

`test:host` membaca `@deepseek-ai/dsh-tools` milik host sendiri dari dalam asar host terpasang; hanya fs bapatch Electron sanggup, jalankan di dalam proses host. Di node biasa ia melaporkan SKIP sebagai jelas, tanpa menebak host menolak kita.

Rang offline menata perangkat ujinya tangan sendiri — ekstensi pi ber-TypeScript memakai builder TypeBox, bundle DSH memakai `defineTool`, bundle berimport paket host secara telanjang — lalu menyuruh seluruh pipeline berlari terhadap stub terekam, dan benar-benar menjalankan alat yang keluar lewat jembatan. Sebagian aturan hidup sebagai asersi statis, karena menampakkan diri hanya saat start sungguhan: ragam skema yang diterima host; berkas wajib dipublikasi; ketetapan bahwa bundle yang dianalisis tak boleh membangkitkan proses atau mengikat port.

## Apa yang tidak menyeberang

Jembatan melaporkan kasus-kasus ini jujur, alih-alih gagal senyap:

- **UI host**: halaman peramban DSH / `ctx.slots`; peraster TUI milik pi, `ctx.ui`, pintasan kunci, flag CLI.
- **Adaptor model yang teregistrasi ke host**: siapa yang menambah provider melakukannya terhadap host rumahnya sendiri — itulah isi "tidak menerjemahkan" — provider pi turut di pi, adapter DSH turut di DSH.
- **Bundle DSH tanpa apa pun yang bisa dipanggil**: overlay murni antarmuka atau pengaturan tak punya alat untuk diteruskan. Preview menyatakannya jelas, alih-alih mengada-adakan capability.
- **Paket yang menuntut host interaktif**: panggilan terusan bisa mengalirkan kemajuan, tetapi tak bisa memunculkan pemilih di pihak satunya.

## Ketahanan

Registrasi segera jatuh ke sesi sekarang. Tiap host, saat memuat plugin, membaca ulang dari `~/.dsh-pi-bridge/bridges.json` apa yang dicatatnya sendiri, sehingga pemasangan lewat restart — sudah diuji dengan mulai ulang sesi DSH dan menjumpai alat-alat jembatan di tempatnya. Pembacaan ulang hanya membaca cache: start host tak pernah menunggu unduhan jejaring; bila cache dikosongkan, jembatan melaporkan tidak-sia-sia, alih-alih menggantung. Restart juga membuat alat baru kasatmata bagi klien lain (GUI web, jendela kedua), karena mereka meracik daftar alat saat start. Dimatikan lewat `restoreOnLoad: false` di pengaturan bundle.

Kita tidak menulis ke pengaturan host mana pun. `bridge_remove` melupakan satu jembatan dan menghapus direktori buildnya; alat yang teregistrasi ke proses berjalan tetap sampai restart, karena membatalkan registrasi secara diam keadaan host lebih buruk daripada membiarkannya terlihat.

## Keamanan

Paket yang dijembatani **menjalankan kode dengan izinmu, di host tempat ia bekerja**. Semua host ekstensi mensyaratkan hal yang sama; paket ini datang dari ekosistem lain dan belum melewati pemeriksaan pasarnya, maka syaratnya makin berlaku. Baca kode sumbernya dulu; `preview` hanya mengurai dan memeriksa, tidak meregistrasi apa pun.

Penerusan bukan sandbox: paket berjalan dengan kepercayaan penuh hostnya sendiri — sebab itu ia berhasil. Titik akhir loopback terikat hanya ke 127.0.0.1, terbuka hanya bila `DSH_PI_BRIDGE_DSH_SERVE` ditentukan, dan klien menolak alamat non-loopback. Siapa pun yang mencapai port itu sanggup memanggil tiap alat yang dimuat sesi. Buka port hanya bila perlu.

## Susunan

```text
index.js                pintu masuk DSH: name / inject / apply(ctx), yaitu alat-alat pi_*
extensions/index.js     pintu masuk pi: pabrik default(pi), alat dan perintah dsh_*
skills/dsh-pi-bridge/   SKILL.md, dikongsikan kedua host
cordis.patch.yml        pemasangan bundle DSH (sasaran tuas di panel plugin)
daemon/run.mjs          proses pi yang diawasi; muka loopback alat-alatnya
daemon/bootstrap.js     dimuat oleh pemuat ekstensi sungguhan pi masuk ke dalam pi
src/proxy.js            sisi DSH: menyalakan/pakai ulang daemon, meneruskan panggilan
src/dsh-loader.js       sisi DSH: memuat bundle saat berjalan terhadap scope hidup
src/serve.js            sisi DSH: titik akhir loopback bagi host satunya
src/dsh-host-client.js  sisi pi: bercakap dengan sesi DSH yang hidup
src/resolve.js          sumber npm / git / url / lokal ke cache, lengkap pasang dependensi
src/load.js             membangun pohon cermin, kompilasi TS, memasang dependensi sungguhan
src/manifest.js         mengenali host dari keywords, manifest, dan bentuk direktori
src/capture.js          host-stub terekam untuk kedua konvensi pintu masuk
src/schema.js           konversi dua arah skema parameter
src/capabilities.js     model capability ternormalisasi; proyeksi hasil
src/replay-dsh.js       capabilities -> ctx.tools / commands / skills
src/replay-pi.js        capabilities -> pi.registerTool / registerCommand
src/restore.js          membaca ulang jembatan yang tercatat saat host menyala
src/stubs.js            memindai import dan menumbuhkan stub untuk preview
src/tar.js              pembaca gzipped-tar, tanpa dependensi
src/transpile.js        TypeScript -> ESM, lewat node:module
```

`index.js` hanya meng-impor bawaan `node:` plus paket dongan dan menyatakan `inject: ["tools"]` — satu-satunya layanan yang perlu. Skill dan pengaturan diraba lewat `ctx.inject` selepas lulus cek capability; profil tanpa registri sekadar tak mengaitkan skill, alih-alih menjatuhkan start.

## Lisensi

MIT
