# scrapers

Kumpulan scraper standalone. One file, one machine:
no framework, no `npm install` — cukup Node ≥ 18 dan langsung jalan.
Bisa dieksekusi langsung lewat CLI, atau di-import ke project apapun —
bot WhatsApp, API, CLI tools, tinggal tempel.

Repo ini isinya hasil reverse-engineering & rekayasa sendiri — tested
before it lands here. Bukan kumpulan copas, bukan wrapper doang.

---

## Why standalone & no `npm install`?

- **Ambil satu file, jalan** — gak ada langkah install, gak ada riwayat dependency
  yang bisa mati diam-diam pas maintainernya berhenti.
- **Mudah diaudit** — semua logic kebaca dari satu file, gak ada yang
  ke-dll-in dari node_modules.
- **Gampang ditempel** — mau dipake di bot, server, laptop, termux, tinggal
  copy satu file.

> Catatan: beberapa scraper punya fitur opsional yang memanfaatkan tool sistem
> (mis. `ffmpeg` buat nempel-in metadata audio). Kalau tool-nya gak ada, fitur
> itu di-skip otomatis dan scraper tetep jalan penuh. Satu-satunya syarat
> yang wajib cuma Node ≥ 18.
>
> Jadi janji "no npm install" itu: file-nya jalan cukup dengan Node — nothing
> more. Bukan janji tiap scraper bakal 100% bebas tool eksternal selamanya,
> tapi bahwa apapun di luar Node sifatnya opsional dan skip-nya graceful.

---

## Principles

1. **Diuji dulu, masuk kemudian.** Yang gagal atau setengah jalan gak akan
   pernah nongol di repo ini.
2. **Error dijelaskan, bukan didiamkan.** Kalau gagal, pesannya nyebut kenapa
   (mis. video kena bot-check, link kadaluarsa) — biar yang pake tau harus
   ngapain, bukan nebak-nebak.
3. **Behavior server dihormati, bukan dilawan.** Batas rate, budget per-IP,
   dan mekanisme anti-abuse layanan diakui dan diakali dengan cara yang
   masuk akal — bukan di-spam sampe IP diblokir permanen.
4. **Header file = identitas.** Tiap scraper diawali blok `Base / Author /
   Saluran / Features / Usage` — sekali buka file, langsung tau semuanya
   tanpa baca satu baris kode pun.

---

## Structure

```
scrapers/
└── downloader/
    └── yt/
        └── ytVr-lite.mjs     # YouTube extractor & downloader no-PoToken
```

Categories follow function, not language or target:

- `downloader/` — media grabbers (audio/video/gambar)
- kategori lain mengikuti kalau ada scraper baru

---

## Usage

Every scraper ships with its own CLI modes — contoh dari `ytVr-lite.mjs`:

```console
$ node ytVr-lite.mjs <url>            # metadata JSON
$ node ytVr-lite.mjs <url> mp3        # audio
$ node ytVr-lite.mjs <url> mp4 [res]  # video (default 720p)
```

Atau dari kode:

```js
import { extract, audioBuffer } from './downloader/yt/ytVr-lite.mjs'

const info = await extract('https://youtu.be/xxxx')
const { buffer, title, ext } = await audioBuffer('https://youtu.be/xxxx')
```

Detail opsi tiap scraper selalu ada di header file-nya masing-masing.

---

## Legal & ethics

- Scraper di sini cuma **ngambil konten yang secara teknis bisa diakses
  publik** — gak ada bypass DRM, gak ada akun/password, gak ada konten privat.
- File hasil unduhan adalah tanggung jawab si pemake. Hormati hak cipta
  konten kreator.
- Kalau layanan yang di-scrape minta berhenti, ya kita berhenti. Simple as that.

---

## Credits & watermark

© **VenzioLûx** — **Vloûte Cataclysm**

Built and tested on a private VPS. Teknik client Innertube app
pada scraper YouTube merujuk ke [yt-dlp](https://github.com/yt-dlp/yt-dlp) dan paste
extractor ANDROID_VR yang udah beredar di komunitas — sisanya (downloader
budget-aware, anti-trickle paralel, multi-client fallback chain, auto-mux)
hasil rekayasa dan pengujian sendiri.

## License & terms

- **Bebas dipake** buat proyek apapun — pribadi, grup, komersial sekalipun,
  gak perlu izin dulu.
- **Bebas dimodif** sesuai kebutuhan. Ubah seperlunya, tambah fitur, port
  ke bahasa lain, semua oke.
- **Ambil sebagian / copot sebagian kode?** Silahkan, bebas — dihargai kalau
  kasih kredit, tapi gak diwajibkan.
- **Reupload utuh / bikin repo turunan?** WAJIB cantumin kredit: nama
  (VenzioLûx) + link repo ini. Anggap aja hormat kerja orang.
- **Gak boleh:** dijual sebagai-is, atau diklaim hasil kerja sendiri 100%
  tanpa nyebut sumber.

Asal-usul tiap file selalu bisa dicek di header-nya masing-masing
(`Base / Author / Saluran`) — jadi apapun yang kejadian sama repo ini,
jejaknya gak hilang.

---

> © 2026 VenzioLûx — Vloûte Cataclysm. Made with research, coffee, and a
> few hundred failed requests before the first success.