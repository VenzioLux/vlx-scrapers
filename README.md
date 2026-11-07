# scrapers

Kumpulan scraper standalone. Satu file, satu mesin: tanpa framework, tanpa
`npm install` — cukup Node ≥ 18, langsung jalan. Bisa dipakai lewat CLI atau
di-import ke project apa pun (bot WhatsApp, API, CLI tool, tinggal tempel).

Isinya hasil reverse-engineering & pengujian sendiri — bukan kumpulan copas,
bukan wrapper doang.

---

## Kenapa standalone?

- **Ambil satu file, jalan** — tanpa langkah install, tanpa dependency yang
  bisa mati diam-diam.
- **Mudah diaudit** — semua logic kebaca dari satu file.
- **Gampang ditempel** — bot, server, laptop, Termux, tinggal copy.

> Beberapa scraper memakai tool sistem opsional (mis. `ffmpeg`) atau engine
> pihak ketiga. Kalau tool/engine-nya gak ada atau mati, fitur itu fallback
> atau di-skip — scraper tetap jalan. Syarat utamanya cuma Node ≥ 18.

---

## Prinsip

1. **Diuji dulu, masuk kemudian.** Yang gagal atau setengah jalan gak naik.
2. **Error dijelaskan** — output error punya `kind` + pesan gaya mesin, plus
   `detail` berisi konteks mentah dari server.
3. **Batas server dihormati** — rate limit dan anti-abuse diakali dengan akal,
   bukan di-spam sampai IP diblokir permanen.
4. **Header file = dokumentasi.** Tiap file diawali blok
   `Base / Author / Saluran / Features / Usage`. Buka file, langsung paham.
5. **Multi-engine.** Media yang punya banyak sumber gak digantung di satu
   engine — ada fallback, dan sumber yang menang dicatat di field `engine`.

---

## Struktur

```
scrapers/
├── downloader/          # input URL konten -> output file media
│   ├── yt/ytVr-lite.mjs
│   ├── tiktok/{tikMw,tikAlt}.mjs
│   ├── spotify/spVio.mjs
│   ├── fb/fbFast.mjs
│   ├── ig/igVox.mjs
│   ├── x/xGst.mjs
│   └── lk21/lk21P2p.mjs
├── uploader/            # input file lokal -> output link/status
│   └── top4top.mjs
├── stalk/               # input username/nama -> output profil + daftar post
│   └── jne/jnetrack.mjs
├── tools/               # utilitas pendukung, bukan media
│   └── tempmail/{ik,tmail,emailqu}.mjs
└── other/               # belum ada kategori pas
    └── julzFnd.mjs
```

Kategori ikut fungsi, bukan bahasa atau target. Scraper yang belum di-acc ada
di `staging/` (di luar repo git), jadi gak kebetulan ke-`git add`.

---

## Daftar scraper

Detail mode, batas, dan cara kerja tiap scraper ada di header file-nya.

| File | Guna |
|---|---|
| `downloader/yt/ytVr-lite.mjs` | YouTube: metadata, playlist, audio, video, post channel |
| `downloader/tiktok/tikMw.mjs` | TikTok langsung: video no-watermark, audio, foto, slide |
| `downloader/tiktok/tikAlt.mjs` | TikTok via TikWM: search keyword, LivePhoto motion |
| `downloader/spotify/spVio.mjs` | Spotify: search, metadata, lirik LRC, audio multi-engine |
| `downloader/ig/igVox.mjs` | Instagram: post, reel, carousel, story, search |
| `downloader/fb/fbFast.mjs` | Facebook: video/reel HD+SD, audio |
| `downloader/x/xGst.mjs` | X/Twitter: video sampai 4K, foto, profil |
| `downloader/lk21/lk21P2p.mjs` | LK21: info, streams, episodes, unduh MP4 |
| `uploader/top4top.mjs` | Upload file ke top4top.me |
| `stalk/jne/jnetrack.mjs` | Tracking resi JNE |
| `other/julzFnd.mjs` | Cari link preset Alight Motion dari komentar video |
| `tools/tempmail/ik.mjs` | Email sementara InboxKitten: inbox + baca pesan |
| `tools/tempmail/tmail.mjs` | Email sementara Tmail Cloud: bikin alamat, inbox, baca |
| `tools/tempmail/emailqu.mjs` | Email sementara EmailQu: bikin alamat, inbox, baca |

---

## Pakai

```console
$ node downloader/yt/ytVr-lite.mjs <url> mp3
$ node downloader/tiktok/tikAlt.mjs search "keyword" 20
$ node downloader/lk21/lk21P2p.mjs home
$ node tools/tempmail/tmail.mjs new
```

Atau import dari kode:

```js
import { extract, audioBuffer } from './downloader/yt/ytVr-lite.mjs'

const info = await extract('https://youtu.be/xxxx')
const { buffer, title, ext } = await audioBuffer('https://youtu.be/xxxx')
```

Output CLI selalu JSON. Kalau gagal, tetap JSON dengan `status: "error"`,
`kind`, dan exit code 1.

---

## Legal & ethics

- Scraper di sini ngambil konten sesuai kemampuan engine-nya — metadata via
  jalur resmi, media via engine yang tersedia (internal maupun pihak ketiga).
- File hasil unduhan adalah tanggung jawab si pemakai. Hormati hak cipta
  kreator.
- Kalau layanan yang di-scrape minta berhenti, ya kita berhenti.

---

## Credits

© **VenzioLûx** — **Vloûte Cataclysm**

Dibangun dan diuji di VPS pribadi. Teknik client Innertube pada scraper
YouTube merujuk ke [yt-dlp](https://github.com/yt-dlp/yt-dlp) dan paste
extractor ANDROID_VR yang beredar di komunitas — sisanya (downloader
budget-aware, anti-trickle paralel, multi-client fallback, auto-mux) hasil
rekayasa dan pengujian sendiri.

## License & terms

- **Bebas dipakai** — pribadi, grup, komersial, tanpa izin.
- **Bebas dimodifikasi** — ubah, tambah fitur, port ke bahasa lain.
- **Ambil sebagian kode?** Boleh, kredit dihargai tapi tidak diwajibkan.
- **Reupload utuh / bikin repo turunan?** Wajib cantumkan kredit: nama
  (VenzioLûx) + link repo ini.
- **Tidak boleh:** dijual as-is, atau diklaim 100% hasil kerja sendiri tanpa
  menyebut sumber.

Asal-usul tiap file selalu bisa dicek di header-nya (`Base / Author /
Saluran`) — jejaknya gak hilang.

---

> © 2026 VenzioLûx — Vloûte Cataclysm. Made with research, coffee, and a few
> hundred failed requests before the first success.