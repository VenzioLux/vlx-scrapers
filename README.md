# scrapers

Kumpulan scraper standalone. Satu file = satu mesin yang jalan sendiri:
tanpa framework, tanpa dependency eksternal (cuma Node bawaan, >= 18).
Bisa dieksekusi langsung lewat CLI, atau di-import ke project apapun —
bot WhatsApp, API, CLI tools, tinggal tempel.

Repo ini isinya hasil reverse-engineering & rekayasa sendiri yang diuji
langsung sebelum masuk sini. Bukan kumpulan copas, bukan wrapper doang.

---

## Kenapa standalone & zero dependency?

- **Gak ada `npm install`** — ambil satu file, jalan. Gak ada riwayat dependency
  yang bisa mati diam-diam pas maintainernya berhenti.
- **Mudah diaudit** — semua logic kebaca dari satu file, gak ada yang
  ke-dll-in dari node_modules.
- **Gampang ditempel** — mau dipake di bot, server, laptop, termux, tinggal
  copy satu file.

---

## Prinsip yang dipegang semua scraper di sini

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

## Struktur

```
scrapers/
└── downloader/
    └── yt/
        └── yt-vr-lite.mjs     # YouTube extractor & downloader no-PoToken
```

Kategori folder mengikuti fungsi, bukan bahasa atau target:

- `downloader/` — ngambil media (audio/video/gambar)
- kategori lain mengikuti kalau ada scraper baru

---

## Cara pake

Tiap scraper punya mode CLI sendiri — contoh dari `yt-vr-lite.mjs`:

```console
$ node yt-vr-lite.mjs <url>            # metadata JSON
$ node yt-vr-lite.mjs <url> mp3        # audio
$ node yt-vr-lite.mjs <url> mp4 [res]  # video (default 720p)
```

Atau dari kode:

```js
import { extract, audioBuffer } from './downloader/yt/yt-vr-lite.mjs'

const info = await extract('https://youtu.be/xxxx')
const { buffer, title, ext } = await audioBuffer('https://youtu.be/xxxx')
```

Detail opsi tiap scraper selalu ada di header file-nya masing-masing.

---

## Legalitas & etika

- Scraper di sini cuma **ngambil konten yang secara teknis bisa diakses
  publik** — gak ada bypass DRM, gak ada akun/password, gak ada konten privat.
- File hasil unduhan adalah tanggung jawab si pemake. Hormati hak cipta
  konten kreator.
- Kalau layanan yang di-scrape minta berhenti, ya kita berhenti.

---

## Kredit & watermarked

© **VenzioLûx** — **Vloûte Cataclysm**

Dibuat dan diuji langsung dari VPS pribadi. Teknik client Innertube app
pada scraper YouTube merujuk ke [yt-dlp](https://github.com/yt-dlp/yt-dlp) dan paste
extractor ANDROID_VR yang udah beredar di komunitas — sisanya (downloader
budget-aware, anti-trickle paralel, multi-client fallback chain, auto-mux)
hasil rekayasa dan pengujian sendiri.

## Lisensi & pemakaian

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

> © 2026 VenzioLûx — Vloûte Cataclysm. Dibuat dengan riset, kopi, dan
> beberapa ratus request yang gagal sebelum berhasil.