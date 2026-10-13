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
> (mis. `ffmpeg` buat nempel-in metadata audio) atau engine pihak ketiga.
> Kalau tool/engine-nya gak ada atau mati, fitur itu di-skip atau fallback
> otomatis — scraper tetep jalan. Dan kalau suatu scraper emang butuh
> dependency, ya pakai — yang penting jalan dan kegunaannya jelas. Bukan
> dogma "no dependency selalu"; Node ≥ 18 doang yang jadi syarat utama.

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
5. **Multi-engine, bukan single-engine.** Media yang bisa dari banyak sumber
   gak digantungin ke satu engine — ada engine utama + fallback, dan sumber
   yang menang dicatat di output (`engine` field).

---

## Structure

```
scrapers/
├── downloader/                   # media grabbers — output langsung jadi file media
│   ├── yt/
│   │   └── ytVr-lite.mjs         # YouTube extractor & downloader no-PoToken
│   ├── tiktok/
│   │   ├── tikMw.mjs             # TikTok downloader (video/audio/photo/slide)
│   │   └── tikAlt.mjs            # Alternatif: search + LivePhoto via resolver TikWM
│   ├── spotify/
│   │   └── spVio.mjs             # Spotify: search, metadata, lyric sinkron, audio full (multi-engine)
│   ├── fb/
│   │   └── fbFast.mjs             # Facebook video/reel: HD+SD, audio, tanpa login
│   ├── ig/
│   │   └── igVox.mjs             # Instagram: post/reel/carousel/story + search keyword
│   └── x/
│       └── xGst.mjs              # X/Twitter: video sampai 4K asli + foto, tanpa login
├── uploader/                     # push file ke layanan orang — output link/status
│   └── top4top.mjs               # upload ke top4top.me
└── stalk/                        # input username/handle — output profil + daftar post
    └── jne/
        └── jnetrack.mjs          # tracking resi JNE, tanpa browser
└── other/                        # belum masuk kategori — dikumpulin dulu, dipilah belakangan
    └── julzFnd.mjs               # cari URL preset Alight Motion dari video TikTok/YT/IG
```

Categories follow function, not language or target:

- `downloader/` — input URL konten, output file media (mp4/mp3/jpg)
- `uploader/` — input file lokal, output link/status dari layanan orang
- `stalk/` — input username/nama, output profil + daftar post (bisa juga tanpa login)
- `other/` — scraper yang belum punya kategori jelas (mis. output link, bukan media)

Daftar di atas cuma yang **udah naik ke repo**. Scraper yang masih dikerjakan
atau belum di-acc ada di `staging/` (di luar repo git), jadi nggak kebetulan
ke-`git add`.

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

TikTok punya dua mesin, karena dua alasan teknis yang beda:

- **`tikMw.mjs`** — ngambil langsung dari TikTok. Video no-watermark, audio,
  foto carousel, slideshow. Tapi endpoint search TikTok memblokir IP datacenter,
  jadi mode search gak ada di sini.
- **`tikAlt.mjs`** — lewat resolver TikWM, jadi **search keyword** dan
  **LivePhoto motion** bisa jalan dari mana aja, termasuk IP datacenter.

```console
$ node tikMw.mjs  <url> mp4                  # video no-watermark
$ node tikMw.mjs  <url> slide                # foto carousel -> 1 MP4
$ node tikAlt.mjs search "joki derag" 20     # cari video
$ node tikAlt.mjs <url> live  out.mp4        # motion LivePhoto
$ node tikAlt.mjs <url> slide out.mp4        # foto + motion -> 1 MP4
```

Butuh **search**, **metadata lengkap**, **lyric sinkron per baris**
(`[00:01:23] text`), atau **audio full-duration**? `spVio.mjs` buat
Spotify — token anonymous, tanpa login, tanpa API key:

```console
$ node spVio.mjs search "never gonna give you up" 10   # lagu/album/artist/playlist
$ node spVio.mjs <link|id>                            # metadata track
$ node spVio.mjs <link|id> album                      # isi album + semua track
$ node spVio.mjs <link|id> artist                     # profil artist
$ node spVio.mjs <link|id> lyrics  out.lrc            # lyric sinkron (LRC)
$ node spVio.mjs <link|id> mp3     out.mp3            # audio FULL 320kbps (multi-engine)
$ node spVio.mjs <link|id> preview out.mp3            # preview 30 detik (paksa)
```

Audio full-duration lewat **multi-engine**: engine utama `spotidown.app`
(MP3 320kbps, full track, metadata embedded) → fallback preview resmi
30 detik kalau engine mati. Sumber engine dicatat di output (`engine`
field) biar caller tau persis dari mana audio-nya.

Butuh **search Instagram** (yang di app harus login), **story**, atau
**carousel**? `igVox.mjs` — satu file, tanpa login, tanpa cookie:

```console
$ node igVox.mjs search "keraton" 20               # profil / post / reel / hashtag
$ node igVox.mjs <url|shortcode>                   # metadata lengkap
$ node igVox.mjs <url|shortcode> hd   out.mp4      # video sampai 1440p
$ node igVox.mjs <url|shortcode> photo gal         # semua foto carousel
$ node igVox.mjs nasa story        natgeo           # semua story aktif 24 jam
```

Juga **multi-engine**: Instagram langsung jadi engine utama (metadata
paling lengkap + 1440p), engine cadangan otomatis kalau kena login-wall —
hasilnya turun ke 720p dan itu ditulis di output, bukan gagal diam-diam.
Catatan jujur: Highlight butuh login jadi tidak bisa diambil, dan search
cuma mencakup konten yang sudah terindeks publik.

Facebook publik **tanpa login**? `fbFast.mjs` — video/reel aja, HD + SD:

```console
$ node fbFast.mjs <url>                 # metadata super lengkap + semua resolusi
$ node fbFast.mjs <url> hd  out.mp4     # video HD
$ node fbFast.mjs <url> sd  out.mp4     # video SD
$ node fbFast.mjs <url> mp3 out.mp3     # audio MP3 (butuh ffmpeg)
$ node fbFast.mjs <url> audio out.m4a   # audio M4A (butuh ffmpeg)
```

Dua celah kepake bareng: halaman post buat og:title/caption/page, dan
`/plugins/video.php` buat `hd_src` + `sd_src`. Dua halaman di-fetch persis
bersamaan dan cuma dibaca sampai data ketemu, jadi metadata balik < 1 detik;
download pakai Range paralel 4 koneksi streaming ke disk.
Catatan jujur: **foto tidak support** — halaman foto butuh login walau
publik, dan angka views/like/comment cuma format ringkas FB ("2.8J views"),
presisinya butuh login.

X / Twitter sampai **4K asli** tanpa login? `xGst.mjs` — video + foto, nol
cookie, nol API key, nol browser. Nama "Gst" = guest-token, itu intinya:

```console
$ node xGst.mjs <username>                 # daftar 40 tweet terbaru yang ada medianya
$ node xGst.mjs <username> profile         # bio, follower, verified, avatar
$ node xGst.mjs <url-tweet|id>             # metadata + semua variant
$ node xGst.mjs <url-tweet|id> info        # semua resolusi + bitrate, TANPA download
$ node xGst.mjs <url-tweet|id> 1080p out.mp4   # 4k / 2k / 1080p / 720p / 480p / best
$ node xGst.mjs <url-tweet|id> photo gal   # semua foto, resolusi asli
```

Guest token dibuat sendiri dari endpoint X (`guest/activate.json`), cache
~3 jam, auto-refresh pas 401/403. Download pakai **single-stream + resume** —
CDN X kenceng per-koneksi (~10-13 MB/s) dan range paralel 6x justru lebih
lambat, jadi satu koneksi lurus ke disk. Catatan jujur: **nggak ada keyword
search** — X wajib login buat search (`SearchTimeline` gak ada di bundle
publik sama sekali), jadi input yang jalan cuma username atau URL tweet; dan
queryId GraphQL X bisa dirotasi kapan aja — kalau muncul error
`queryId udah dirotasi`, itu maintenance berkala, bukan bug.

Butuh **link preset Alight Motion** (5mb & XML) yang biasa dikubur di komentar
video TikTok/YouTube/Instagram? `julzFnd.mjs` — tempel linknya, presetnya keluar.
Ini **bukan downloader**: output-nya link preset, bukan file, makanya masuk
folder `other/` dulu.

```console
$ node other/julzFnd.mjs <url>          # cari preset + metadata lengkap
$ node other/julzFnd.mjs <url> presets  # cuma daftar URL preset
$ node other/julzFnd.mjs <url> open     # buka semua url preset di browser
```

Balasan komentar ikut dibaca, jadi preset yang cuma dikasih di balasan tetep
kedetek (`byAuthor` nandain kalau dari author sendiri). Batasan jujur: cuma
nemu yang udah publik di komentar/deskripsi — kalau presetnya ada di DM atau
grup private, nggak baket nemu. Situs pakai cookie-gate `am_c` (timestamp+hash,
divalidasi server) yang diambil dari HTML pertama dan di-cache 1 jam.

---

## Legal & ethics

- Scraper di sini ngambil konten sesuai kemampuan engine-nya — metadata via
  jalur resmi, media via engine yang tersedia (internal maupun pihak ketiga).
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