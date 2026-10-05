/*
  Base : instagram.com / savefromins.com / ig.media / kol.id / cse.google.com
  Author : VenzioLûx
  Channel: https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
  Req: Node >= 18, 1 file, tanpa login/cookie/API key/dependency, output JSON

  Features:
    - Support: post, reel, carousel, story, search keyword (shortcode doang bisa)
    - Multi-engine: Utama IG (meta lengkap + HD 1440p), Cadangan 3rd party auto aktif kalo Utama kena 302/login-wall/403
    - Engine media = savefromins. Balikin URL CDN Instagram langsung, multi-resolusi, plus tanggal unggah + cuplikan komentar. Jauh lebih cepat dari mirror lain
    - Engine angka = ig.media. Satu-satunya yang bisa baca `views`, jadi angka like/komentar/view tetap kebaca walau engine utama kena login-wall
    - Null = Instagram memang tidak mempublikasikannya, bukan 0
    - Search: IG ga ada endpoint publik, jadi via Google CSE. Cuma yang udah terindeks, profil/post/reel/hashtag. Bisa rate limit kalo spam, post baru belum muncul
    - Story: via kol.id, satu-satunya engine yg bisa baca story tanpa login. Cuma story aktif 24 jam dari /stories/<username>/
    - Highlight: TIDAK SUPPORT. Butuh login, pasti "Media not found"
    - HD: DASH VP9 up to 1440p + ffmpeg. Kalo ffmpeg ga ada auto turun ke 720p progressive, bukan gagal. Quality ditulis di field `quality`
    - Child carousel shortcode auto redirect ke induk

  Usage:
  node igVox.mjs <url|shortcode> [info|mp4|hd|mp3|audio|photo|story|cover] [output]
  node igVox.mjs search <keyword> [limit] [page]

  Ex:
  node igVox.mjs CUbHfhpswxt photo
  node igVox.mjs nasa story
  node igVox.mjs https://instagram.com/reel/DV3dfTYjZVj/ hd starship.mp4
  node igVox.mjs search "keraton" 20
*/

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const BASE = 'https://www.instagram.com'
const KOL = 'https://kol.id'
const IGM = 'https://api.ig.media'
const SFI = 'https://api.savefromins.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const APP_ID = '936619743392459'
const CSE_CX = 'e6026ed556b87469d'
const CSE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const HDR_PAGE = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none', 'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
}
const HDR_CDN = { 'user-agent': UA, accept: '*/*', referer: BASE + '/', 'accept-language': 'en-US,en;q=0.9' }

const HDR_CSE = { 'user-agent': CSE_UA, accept: '*/*', referer: 'https://www.instasearchengine.com/' }
const HDR_IGM = { 'content-type': 'application/json', referer: 'https://ig.media/', 'user-agent': UA, accept: 'application/json, text/plain, */*' }
const HDR_SFI = { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://savefromins.com/', 'user-agent': UA, accept: 'application/json, text/plain, */*' }
const HDR_KOL = {
    'user-agent': UA,
    'content-type': 'application/x-www-form-urlencoded',
    referer: KOL + '/download-video/instagram',
    origin: KOL,
    'x-requested-with': 'XMLHttpRequest',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const _hasFF = (() => { try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 } catch { return false } })()

const _pgCache = new Map()
const _PG_TTL = 5 * 60_000
const _igmCache = new Map()
const _kolCache = new Map()
const _KOL_TTL = 10 * 60_000
const _KOL_GAP = 350
let _kolChain = Promise.resolve()
const _IGM_TTL = 5 * 60_000
const _sfiCache = new Map()
const _SFI_TTL = 10 * 60_000
const _SFI_AUTH = '20250901majwlqo'
const _SFI_DOMAIN = 'api-ak.savefromins.com'
const _IGM_SECRET = '38439a9d35050fd482cc114a8c455d239e666c87f8d58912bb15fa67f35866ca'
const _IGM_VER = '0.1.62'
let _igmClient = null


function _serial(fn) {
    const next = _kolChain.then(async () => { await sleep(_KOL_GAP); return fn() })
    _kolChain = next.catch(() => { })
    return next
}

function _cacheGet(map, key, ttl) {
    const hit = map.get(key)
    if (!hit) return null
    if (Date.now() - hit.at > ttl) { map.delete(key); return null }
    return hit.data
}

function _cachePut(map, key, data, max = 200) {
    if (map.size > max) map.delete(map.keys().next().value)
    map.set(key, { at: Date.now(), data })
}

//target
const _STORY_USER = /^[\w.]{1,40}$/
const _CODE = /^[A-Za-z0-9_-]{5,32}$/

export function resolveTarget(input) {
    const raw = String(input || '').trim()
    if (!raw) throw new Error('URL, shortcode, atau username Instagram wajib diisi. Contoh: https://www.instagram.com/reel/DV3dfTYjZVj/')

    const sm = raw.match(/instagram\.com\/(stories|highlights?)\/([^/?#]+)(?:\/(\d+))?/i)
    if (sm) {
        const seg = sm[2]
        if (!/^(highlights?|reels?)$/i.test(seg)) return { kind: 'story', user: seg, url: `${BASE}/stories/${seg}/` }
        throw new Error('URL story-nya belum ada username. Bentuknya: https://www.instagram.com/stories/<username>/ atau /stories/highlights/<kode>/')
    }

    const pm = raw.match(/\/(?:p|reel|reels|tv|share)\/([A-Za-z0-9_-]{5,32})/)
    if (pm) {
        const scoped = raw.match(/instagram\.com\/([A-Za-z0-9_.]+)\/(?:p|reel|reels|tv|share)\//i)
        return { kind: 'post', code: pm[1], url: `${BASE}/p/${pm[1]}/`, scoped: scoped?.[1] || '' }
    }

    // string polos tanpa URL
    const bare = raw.replace(/^@/, '')
    if (_CODE.test(raw)) {
        const ambiguous = raw === raw.toLowerCase()
        return { kind: 'post', code: raw, url: `${BASE}/p/${raw}/`, ambiguous, user: ambiguous ? bare : '' }
    }

    if (_STORY_USER.test(bare)) return { kind: 'story', user: bare, url: `${BASE}/stories/${bare}/` }

    throw new Error('URL atau shortcode Instagram gak valid. Contoh: https://www.instagram.com/reel/DV3dfTYjZVj/ atau search "nasa"')
}

async function _page(url, tries = 3) {
    const hit = _cacheGet(_pgCache, url, _PG_TTL)
    if (hit) return hit
    let last = ''
    for (let i = 0; i < tries; i++) {
        try {
            const ctrl = new AbortController()
            const t = setTimeout(() => ctrl.abort(), 30000)
            const res = await fetch(url, { headers: HDR_PAGE, redirect: 'manual', signal: ctrl.signal })
            clearTimeout(t)
            if (res.status === 429) throw new Error('kena rate limit Instagram (429). Tunggu 1-2 menit lalu coba lagi.')
            if (res.status === 403) throw new Error('Instagram memblokir akses dari IP ini (403).')
            if (res.status >= 300 && res.status < 400) {
                const loc = res.headers.get('location') || ''
                if (/accounts\/login/i.test(loc)) {
                    const e = new Error('Instagram balas 302 ke halaman login untuk akses anonim. Instagram sekarang menyimpan halaman post/reel di balik login, jadi mode ini butuh IP/akun yang tidak kena login-wall. Mode search tidak terpengaruh.')
                    e.fatal = true
                    throw e
                }
                last = `HTTP ${res.status}`
                await sleep(800 * (i + 1))
                continue
            }
            const html = await res.text()
            if (res.status !== 200) { last = `HTTP ${res.status}`; await sleep(800 * (i + 1)); continue }
            if (!html.includes('xig_polaris_media')) {
                last = 'HTML tanpa blok media (kemungkinan login-wall atau post memang tidak ada)'
                await sleep(800 * (i + 1))
                continue
            }
            _cachePut(_pgCache, url, html, 40)
            return html
        } catch (e) { last = e.message; await sleep(800 * (i + 1)) }
    }
    throw new Error(`gagal buka halaman Instagram (${last}).`)
}

function _matchObj(s, start) {
    let depth = 0
    for (let i = start; i < s.length; i++) {
        const c = s[i]
        if (c === '{') depth++
        else if (c === '}') { depth--; if (!depth) return i }
        else if (c === '"') { i++; while (i < s.length && (s[i] !== '"' || s[i - 1] === '\\')) i++ }
    }
    return -1
}

function _blobs(html) {
    const out = []
    let idx = 0
    while ((idx = html.indexOf('"xig_polaris_media"', idx)) !== -1) {
        const start = html.indexOf('{', idx)
        if (start === -1) break
        const end = _matchObj(html, start)
        if (end === -1) break
        try {
            let d = JSON.parse(html.slice(start, end + 1))
            if (d?.if_not_gated_logged_out) d = d.if_not_gated_logged_out
            if (d?.code) out.push(d)
        } catch { }
        idx = end
    }
    return out
}

const _unesc = (s) => String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

function _meta(html) {
    const o = {}
    for (const m of html.matchAll(/property="og:([^"]*)" content="([^"]*)"/g)) o[m[1]] = _unesc(m[2])
    return o
}

//parse DASH
function _dash(manifest) {
    if (!manifest) return { videos: [], audios: [] }
    const sets = manifest.split('<AdaptationSet').slice(1)
    const reps = (chunk) => [...chunk.split('<Representation ').slice(1)].map((r) => ({
        bandwidth: +(r.match(/\sbandwidth="(\d+)"/) || [])[1] || 0,
        width: +(r.match(/\swidth="(\d+)"/) || [])[1] || 0,
        height: +(r.match(/\sheight="(\d+)"/) || [])[1] || 0,
        label: (r.match(/FBQualityLabel="([^"]+)"/) || [])[1] || '',
        codec: (r.match(/codecs="([^"]+)"/) || [])[1] || '',
        url: ((r.match(/<BaseURL>([^<]+)<\/BaseURL>/) || [])[1] || '').replace(/&amp;/g, '&'),
    })).filter((x) => x.url)
    const videos = reps(sets[0] || '').sort((a, b) => b.bandwidth - a.bandwidth)
    const audios = reps(sets[1] || '').sort((a, b) => b.bandwidth - a.bandwidth)
    const dur = (manifest.match(/mediaPresentationDuration="PT([\d.]+)S"/) || [])[1]
    return { videos, audios, durationSec: Math.round(Number(dur) || 0) }
}

const _cands = (m) => (m?.image_versions2?.candidates || []).filter(c => c?.url)
const _imgs = (m) => [..._cands(m)].sort((a, b) => (b.width * b.height) - (a.width * a.height))
const _dashMpd = (m) => _dash(m?.video_dash_manifest)

const _dur = (s) => { const t = Math.round(Number(s) || 0); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` }
const _when = (ts) => ts ? new Date(Number(ts) * 1000).toISOString() : null
const _count = (n) => Number(n || 0).toLocaleString('en-US')
const _compact = (n) => {
    const v = Number(n || 0)
    if (v >= 1e9) return +(v / 1e9).toFixed(1) + 'B'
    if (v >= 1e6) return +(v / 1e6).toFixed(1) + 'M'
    if (v >= 1e3) return +(v / 1e3).toFixed(1) + 'K'
    return String(v)
}

function _mediaKind(m) {
    if (!m) return 'unknown'
    if (m.media_type === 8 || m.carousel_media?.length) return 'carousel'
    if (m.media_type === 2) return m.product_type === 'clips' ? 'reel' : 'video'
    if (m.media_type === 1) return 'photo'
    return 'unknown'
}

function _sound(m) {
    const cm = m?.clips_metadata || {}
    const mi = (cm.music_info?.music_asset_info) || {}
    const osi = (cm.original_sound_info?.original_sound_info) || {}
    const s = osi.title ? osi : (mi.title ? mi : null)
    if (!s) return null
    return { title: s.title || '', artist: s.display_artist || s.author_name || '', explicit: !!s.is_explicit }
}

// metadata post/reel
async function _nativeFetch(t) {
    const html = await _page(t.url)
    const all = _blobs(html)
    if (!all.length) {
        const e = new Error(`post "${t.code}" gak ketemu. Bisa dihapus, private, atau link-nya salah.`)
        e.fatal = true
        throw e
    }
    const m = all.find(x => x.code === t.code) || all[0]
    const og = _meta(html)
    const kind = _mediaKind(m)
    const dash = _dashMpd(m)
    const durSec = Number(m.video_duration) || dash.durationSec || 0
    const owner = m.user || {}
    const kids = m.carousel_media || []
    const cap = (m.caption?.text || '').trim()

    const items = kids.length
        ? kids.map((c, i) => ({
            index: i + 1, kind: _mediaKind(c),
            width: c.original_width || 0, height: c.original_height || 0,
            images: _imgs(c).slice(0, 3).map(x => ({ width: x.width, height: x.height, url: x.url })),
            videos: (c.video_versions || []).map(v => ({ type: v.type, url: v.url })),
            audio: c.has_audio,
        }))
        : [{
            index: 1, kind,
            width: m.original_width || 0, height: m.original_height || 0,
            images: _imgs(m).slice(0, 3).map(x => ({ width: x.width, height: x.height, url: x.url })),
            videos: (m.video_versions || []).map(v => ({ type: v.type, url: v.url })),
            audio: !!m.has_audio,
        }]

    return {
        id: String(m.pk || ''),
        code: m.code,
        shortcode: t.code,
        type: kind,
        productType: m.product_type || '',
        url: og.url || `${BASE}/p/${m.code}/`,
        caption: cap,
        captionEdited: !!m.caption_is_edited,
        accessibilityCaption: m.accessibility_caption || '',
        description: og.description || '',
        author: {
            username: owner.username || '',
            fullName: owner.full_name || '',
            verified: !!owner.is_verified,
            private: !!owner.is_private,
            id: String(owner.pk || ''),
            url: owner.username ? `${BASE}/${owner.username}/` : '',
            profilePic: owner.profile_pic_url || owner.profile_image_uri || '',
        },
        likes: Number(m.like_count) || 0,
        likesLabel: _count(m.like_count),
        likesShort: _compact(m.like_count),
        comments: Number(m.comment_count) || 0,
        views: Number(m.play_count) || 0,
        viewsLabel: _count(m.play_count),
        takenAt: _when(m.taken_at),
        postedAt: _when(m.taken_at),
        width: m.original_width || 0,
        height: m.original_height || 0,
        durationSec: durSec,
        duration: _dur(durSec),
        hasAudio: !!m.has_audio,
        music: _sound(m),
        location: m.location ? { name: m.location.name || '', lat: m.location.lat, lng: m.location.lng } : null,
        hashtags: (cap.match(/#[A-Za-z0-9_]+/g) || []).map(h => h.slice(1)),
        mentions: (cap.match(/@[A-Za-z0-9_.]+/g) || []).map(h => h.slice(1)),
        topics: (m.related_topic_pills || []).map(tp => tp.topic_name).filter(Boolean),
        qualities: dash.videos.map(v => ({ label: `${v.height}p`, width: v.width, height: v.height, kbps: Math.round(v.bandwidth / 1000), codec: v.codec })),
        audioKbps: Math.round((dash.audios[0]?.bandwidth || 0) / 1000),
        items,
        _raw: m,
    }
}

let _nativeDown = 0
const _NATIVE_DOWN = 10 * 60_000

async function _nativeInfo(t) {
    if (Date.now() < _nativeDown) throw new Error('engine Instagram lagi di-cool-down abis kena login-wall.')
    try { return await _nativeFetch(t) } catch (e) { _nativeDown = Date.now() + _NATIVE_DOWN; throw e }
}

const _KOL_MSG = {
    4000: 'URL-nya bukan URL Instagram yang bisa diproses.',
    4001: 'kol.id gagal proses media ini.',
    4004: 'Media not found. Untuk story: mungkin akunnya memang ga ada story aktif sekarang, atau account-nya private.',
}

async function _kolAsk(url, tries = 3) {
    let last = ''
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(`${KOL}/api/v2/downloader/instagram`, {
                method: 'POST', headers: HDR_KOL,
                body: new URLSearchParams({ url }).toString(),
                signal: AbortSignal.timeout(35000),
            })
            if (res.status === 429) {
                const wait = Math.min(Number(res.headers.get('retry-after')) || 30, 120) * 1000
                last = `kol.id minta tunggu ${Math.round(wait / 1000)} detik`
                await sleep(wait)
                continue
            }
            if (res.status === 403) { last = 'kol.id menolak request (403).'; await sleep(1200 * (i + 1)); continue }
            const j = await res.json().catch(() => null)
            if (j && typeof j.meta?.code === 'number') return j
            last = res.ok ? 'respons kol.id tidak dikenali' : `HTTP ${res.status}`
            await sleep(800 * (i + 1))
        } catch (e) { last = e.message === 'The operation was aborted' ? 'timeout' : e.message; await sleep(800 * (i + 1)) }
    }
    throw new Error(`gagal menghubungi kol.id (${last}).`)
}

async function _kolSolve(url) {
    const hit = _cacheGet(_kolCache, url, _KOL_TTL)
    if (hit) return { ...hit, fromCache: true }

    const j = await _serial(() => _kolAsk(url))
    let code = j.meta.code
    let data = j.data

    if (code === 2020 && data?.status_url) {
        const step = Math.min(Number(data.poll_after) || 5, 8) * 1000
        for (let i = 0; i < 10; i++) {
            await sleep(step)
            const pj = await _serial(async () => {
                const r = await fetch(data.status_url, { headers: HDR_KOL, signal: AbortSignal.timeout(35000) })
                return r.json().catch(() => null)
            })
            code = pj?.meta?.code
            data = pj?.data
            if (code === 2001 && data) break
            if ([4000, 4001, 4004].includes(code)) break
        }
    }

    if (code !== 2001 || !data) throw new Error(_KOL_MSG[code] || j.meta?.message || `kol.id kode ${code}.`)

    const slides = Array.isArray(data.slides) ? data.slides : []
    const items = slides.length
        ? slides.map((s, i) => ({
            index: i + 1,
            kind: s.type || (/_n\.jpg|jpeg|\.jpg/i.test(String(s.url)) ? 'image' : 'video'),
            quality: s.quality || '',
            url: s.url || '',
            thumbnail: s.thumbnail || '',
        }))
        : data.video_url
            ? [{ index: 1, kind: 'video', quality: '', url: data.video_url, thumbnail: data.thumbnail || '' }]
            : []
    if (!items.length) throw new Error('kol.id balancer tapi tidak ada URL media di responsnya.')

    const out = {
        title: data.title || '',
        author: data.author || '',
        kind: data.type === 'video' ? 'video' : (items.length > 1 ? 'carousel' : 'image'),
        thumbnail: data.thumbnail || '',
        sourceUrl: url,
        items,
    }
    _cachePut(_kolCache, url, out)
    return out
}

async function _kolStoryInfo(t) {
    const d = await _kolSolve(t.url)
    const cap = d.title || ''
    const video = d.items.find(x => x.kind === 'video')
    return {
        id: '',
        code: t.code || '',
        shortcode: t.code || '',
        type: 'story',
        url: `${BASE}/stories/${t.user}/`,
        caption: cap,
        captionEdited: false,
        accessibilityCaption: '',
        description: cap,
        author: {
            username: d.author || t.user || '',
            fullName: d.author || '',
            verified: false,
            private: false,
            url: d.author ? `${BASE}/${d.author}/` : '',
            profilePic: '',
        },
        likes: null, likesLabel: '', likesShort: '',
        comments: null,
        views: null, viewsLabel: '',
        takenAt: null, postedAt: null,
        width: 0, height: 0,
        durationSec: 0, duration: '',
        engagementAvailable: false,
        metadataNote: 'Angka like/komentar/view buat story ga dipublikasikan Instagram, jadi nilainya null.',
        commentSamples: [],
        variants: [],
        hasAudio: !!video,
        music: null,
        location: null,
        hashtags: (cap.match(/#[A-Za-z0-9_]+/g) || []).map(h => h.slice(1)),
        mentions: (cap.match(/@[A-Za-z0-9_.]+/g) || []).map(h => h.slice(1)),
        topics: [],
        qualities: [],
        audioKbps: 0,
        count: d.items.length,
        fromCache: !!d.fromCache,
        items: d.items.map(i => ({
            index: i.index, kind: i.kind, quality: i.quality, url: i.url,
            thumbnail: i.thumbnail, width: 0, height: 0, audio: i.kind === 'video',
        })),
        _media: d,
    }
}

async function _kolStoryVideo(t, hd) {
    const d = await _kolSolve(t.url)
    const pick = d.items.find(x => x.kind === 'video') || d.items[0]
    if (!pick?.url) throw new Error('kol.id tidak mengembalikan URL video untuk story ini.')
    return {
        ..._slim(await _kolStoryInfo(t)),
        buffer: await _get(pick.url, { ...HDR_CDN, referer: KOL + '/' }),
        ext: 'mp4', mimetype: 'video/mp4', ffmpeg: false,
        quality: `${pick.quality || 'HD'}${hd ? ' (HD butuh login, dilewati)' : ''}`,
    }
}

async function _kolStoryAudio(t, mp3) {
    const d = await _kolSolve(t.url)
    const pick = d.items.find(x => x.kind === 'video') || d.items[0]
    if (!pick?.url) throw new Error('kol.id tidak mengembalikan URL video untuk story ini.')
    if (!_hasFF) throw new Error('mode audio harus ekstrak pakai ffmpeg, dan ffmpeg tidak ada di sistem ini. Pakai mode mp4 aja.')
    const raw = await _get(pick.url, { ...HDR_CDN, referer: KOL + '/' })
    const args = mp3 ? ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'] : ['-vn', '-c:a', 'copy', '-movflags', '+faststart']
    return {
        ..._slim(await _kolStoryInfo(t)),
        buffer: _ff({ buffer: raw, ext: 'mp4' }, args, mp3 ? 'mp3' : 'm4a'),
        ext: mp3 ? 'mp3' : 'm4a', mimetype: mp3 ? 'audio/mpeg' : 'audio/mp4', ffmpeg: true,
    }
}

const _SFI_JUNK = /^0+\s*[xX]?\s*0*$/i

function _sfiResources(m) {
    const vs = (m.resources || []).filter(r => r.download_url && !_SFI_JUNK.test(String(r.quality || '').trim()))
    const isVideo = m.type === 'video' || vs.some(r => String(r.format || '').toLowerCase() === 'mp4')
    return vs.map(r => {
        const q = String(r.quality || '').trim()
        const format = String(r.format || '').toLowerCase()
        return {
            label: q || (isVideo ? 'HD' : 'original'),
            format,
            url: r.download_url,
            size: Number(r.size) || 0,
            muxed: isVideo && !q,
        }
    })
}

const _SFI_RANK = { '1080P': 5, '1080p': 5, '720P': 4, '720p': 4, '480P': 3, '480p': 3, '360P': 2, '360p': 2, '240P': 1, '240p': 1 }
const _sfiBest = (vs) => vs.reduce((a, b) => {
    if (!!b.muxed !== !!a.muxed) return b.muxed ? b : a
    return (_SFI_RANK[b.label] || 0) >= (_SFI_RANK[a.label] || 0) ? b : a
}, vs[0])

async function _sfiSolve(url) {
    const d = await _sfiRaw(url)
    if (!d) throw new Error('savefromins tidak mengembalikan data untuk media ini.')

    const items = []
    for (const m of d.media || []) {
        const vs = _sfiResources(m)
        if (!vs.length) continue
        const isVideo = vs.some(v => v.muxed) || m.type === 'video'
        const best = _sfiBest(vs)
        items.push({
            index: items.length + 1,
            kind: isVideo ? 'video' : 'image',
            quality: best.label,
            url: best.url,
            thumbnail: m.thumbnail || '',
            ext: best.format || (isVideo ? 'mp4' : 'jpg'),
            variants: vs,
        })
    }
    if (!items.length) throw new Error('savefromins balas benar tapi tidak ada URL media yang bisa dipakai.')

    const anyVideo = items.some(i => i.kind === 'video')
    return {
        title: d.title || '',
        author: d.user_item?.nickname || '',
        kind: anyVideo ? 'video' : (items.length > 1 ? 'carousel' : 'image'),
        thumbnail: d.thumbnail || '',
        sourceUrl: url,
        items,
    }
}

async function _sfiInfo(t) {
    const d = await _sfiSolve(t.url)
    const cap = d.title || ''
    const isStory = t.kind === 'story'
    const video = d.items.find(x => x.kind === 'video')
    return {
        id: '',
        code: t.code || '',
        shortcode: t.code || '',
        type: isStory ? 'story' : d.kind,
        url: isStory ? `${BASE}/stories/${t.user}/` : `${BASE}/p/${t.code}/`,
        caption: cap,
        captionEdited: false,
        accessibilityCaption: '',
        description: cap,
        author: {
            username: d.author || t.user || '',
            fullName: d.author || '',
            verified: false,
            private: false,
            url: d.author ? `${BASE}/${d.author}/` : '',
            profilePic: '',
        },
        likes: null, likesLabel: '', likesShort: '',
        comments: null,
        views: null, viewsLabel: '',
        takenAt: null, postedAt: null,
        width: 0, height: 0,
        durationSec: 0, duration: '',
        engagementAvailable: false,
        metadataNote: 'Angka like/komentar/view belum ditemukan untuk konten ini, jadi nilainya null (tidak diketahui), bukan 0.',
        commentSamples: [],
        variants: [],
        hasAudio: !!video,
        music: null,
        location: null,
        hashtags: (cap.match(/#[A-Za-z0-9_]+/g) || []).map(h => h.slice(1)),
        mentions: (cap.match(/@[A-Za-z0-9_.]+/g) || []).map(h => h.slice(1)),
        topics: [],
        qualities: video
            ? video.variants.map(v => ({ label: v.label, width: 0, height: 0, kbps: 0, codec: 'h264+aac' }))
            : [],
        audioKbps: 0,
        count: d.items.length,
        fromCache: false,
        items: d.items.map(i => ({
            index: i.index, kind: i.kind, quality: i.quality, url: i.url,
            thumbnail: i.thumbnail, width: 0, height: 0, audio: i.kind === 'video',
        })),
        _media: d,
    }
}

const _igmId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16)

async function _igmToken(cid) {
    const r = await fetch(`${IGM}/api/client-config`, { headers: { ...HDR_IGM, 'x-client-id': cid } })
    if (!r.ok) return ''
    const j = await r.json()
    return j.token || ''
}

const _igmVisit = () => Buffer.from(JSON.stringify({
    v: `vid_${crypto.randomBytes(6).toString('hex')}`,
    c: 1, t: Date.now(), r: '',
})).toString('base64')

async function _igmAsk(url, fresh = false) {
    if (fresh || !_igmClient) _igmClient = { cid: _igmId(), tok: '' }
    const c = _igmClient
    if (!c.tok) c.tok = await _igmToken(c.cid)
    const body = JSON.stringify({
        url, sessionId: crypto.randomUUID(), version: _IGM_VER, _vt: _igmVisit(),
    })
    const ts = Date.now().toString()
    const sig = crypto.createHmac('sha256', _IGM_SECRET).update(`${ts}.${body}`).digest('hex')
    const r = await fetch(`${IGM}/api/instagram-media`, {
        method: 'POST',
        headers: {
            ...HDR_IGM,
            'x-hmac-signature': sig,
            'x-timestamp': ts,
            'x-csrf-token': c.tok,
            'x-browser-fp': c.cid,
        },
        body,
    })
    const j = await r.json().catch(() => null)
    return r.ok && j ? j : null
}

//kalau 403 = kuota client-id habis, putar ulang pakai id baru sekali lagi
async function _igmRaw(url) {
    const hit = _cacheGet(_igmCache, url, _IGM_TTL)
    if (hit) return hit
    let j = await _igmAsk(url)
    if (!j) j = await _igmAsk(url, true)
    if (j) _cachePut(_igmCache, url, j)
    return j
}

function _igmNum(n) {
    return Number.isFinite(Number(n)) && n !== null && n !== undefined ? Number(n) : null
}

const _GENERIC_CAPTION = /^(instagram(\s+download)?|download|untitled|photo|video|reel)$/i

async function _sfiRaw(url) {
    const hit = _cacheGet(_sfiCache, url, _SFI_TTL)
    if (hit) return hit
    const r = await fetch(`${SFI}/api/contentsite_api/media/parse`, {
        method: 'POST',
        headers: HDR_SFI,
        body: new URLSearchParams({ auth: _SFI_AUTH, domain: _SFI_DOMAIN, origin: 'source', link: url }).toString(),
    })
    if (!r.ok) return null
    const j = await r.json().catch(() => null)
    const d = j?.status_code === 'success' ? j.data : null
    if (d) _cachePut(_sfiCache, url, d)
    return d
}

const _sfiParts = (d) => (d.media || []).flatMap(m => _sfiResources(m))

async function _engage(meta, url) {
    const [igm, sfi] = await Promise.all([
        _igmRaw(url).catch(() => null),
        _sfiRaw(url).catch(() => null),
    ])
    if (!igm && !sfi) return meta

    const likes = _igmNum(igm?.like_count ?? sfi?.like_count)
    const comments = _igmNum(igm?.comment_count ?? sfi?.comment_count)
    const views = _igmNum(igm?.play_count)
    const got = likes !== null || comments !== null || views !== null

    const cap = typeof igm?.caption === 'string' ? igm.caption : (sfi?.title || '')
    const generic = !meta.caption || _GENERIC_CAPTION.test(meta.caption)
    const caption = (cap && generic) ? cap : (meta.caption || cap)

    const posted = Number(sfi?.publish_ts) || 0
    const iso = posted ? new Date(posted * 1000).toISOString() : null
    const samples = (sfi?.comment_items?.items || [])
        .filter(c => c?.text)
        .map(c => ({ username: c.username || '', text: String(c.text).slice(0, 300) }))
    const variants = sfi ? _sfiParts(sfi) : []
    return {
        ...meta,
        caption,
        description: caption,
        hashtags: (caption.match(/#[A-Za-z0-9_]+/g) || []).map(h => h.slice(1)),
        mentions: (caption.match(/@[A-Za-z0-9_.]+/g) || []).map(h => h.slice(1)),
        likes,
        likesLabel: likes === null ? '' : _count(likes),
        likesShort: likes === null ? '' : _compact(likes),
        comments,
        views,
        viewsLabel: views === null ? '' : _count(views),
        takenAt: meta.takenAt || iso,
        postedAt: meta.postedAt || iso,
        commentSamples: samples,
        variants,
        engagementAvailable: got,
        metadataNote: got ? '' : 'Angka like/komentar/view tidak dipublikasikan Instagram untuk konten ini, jadi nilainya null.',
        _igm: igm,
        _sfi: sfi,
    }
}

//engine search
let _cseTok = { value: '', at: 0 }
const _CSE_GAP = 1500
const _CSE_TTL = 90 * 1000
const _cseRes = new Map()
let _cseLast = 0

let _cseChain = Promise.resolve()
function _cseQueue(fn) {
    const next = _cseChain.then(async () => {
        const wait = _CSE_GAP - (Date.now() - _cseLast)
        if (wait > 0) await sleep(wait)
        try { return await fn() } finally { _cseLast = Date.now() }
    })
    _cseChain = next.catch(() => { })
    return next
}

async function _cseToken(force = false) {
    if (!force && _cseTok.value && Date.now() - _cseTok.at < 30 * 60_000) return _cseTok.value
    const res = await fetch(`https://cse.google.com/cse.js?cx=${CSE_CX}`, { headers: { 'user-agent': CSE_UA }, signal: AbortSignal.timeout(25000) })
    const js = await res.text()
    const m = js.match(/cse_token"\s*:\s*"([^"]+)"/)
    if (!m) throw new Error('token search gak bisa diambil dari cse.js (kemungkinan Google ganti format).')
    _cseTok = { value: m[1], at: Date.now() }
    return m[1]
}

async function _cseRaw(q, start, forceNewTok) {
    const u = new URL('https://cse.google.com/cse/element/v1')
    const p = {
        rsz: 'filtered_cse', num: '10', hl: 'en', source: 'gcsc', gss: '.com',
        cselibv: '3735a6ee3000c0cb', cx: CSE_CX, q, safe: 'active',
        cse_tok: await _cseToken(forceNewTok),
        filter: '0', exp: 'cc,sps,esbfa', callback: 'google.search.cse.api1',
        rurl: 'https://www.instasearchengine.com/',
    }
    if (start) p.start = String(start)
    for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v)
    const res = await _cseQueue(() => fetch(u, { headers: HDR_CSE, signal: AbortSignal.timeout(30000) }))
    const txt = await res.text()
    const body = txt.replace(/^\/\*[\s\S]*?\*\/\s*google\.search\.cse\.api\d*\(/, '').replace(/\);\s*$/, '')
    let parsed
    try { parsed = JSON.parse(body) } catch { throw new Error(`respons mesin search gak bisa dibaca (HTTP ${res.status}).`) }
    if (parsed.error) {
        const e = new Error(`mesin search menolak: ${parsed.error.message || parsed.error.code}.`)
        e.code = parsed.error.code
        throw e
    }
    if (!res.ok) throw new Error(`mesin search balas ${res.status}`)
    return parsed
}

function _urlKind(url) {
    const m = url.match(/instagram\.com\/([^/?#]+)(?:\/([^/?#]+))?/i)
    if (!m) return { kind: 'other' }
    const a = m[1], b = m[2] || ''
    const al = a.toLowerCase(), bl = b.toLowerCase()
    if (al === 'explore' && bl === 'tags') return { kind: 'hashtag', tag: b }
    if (al === 'p') return { kind: 'post', code: b }
    if (al === 'reel' || al === 'tv') return { kind: 'reel', code: b }
    if (al === 'stories') return { kind: 'story', user: b }
    if (al === 'reels') return { kind: 'other' }
    if (b && !bl) return { kind: 'other' }
    return { kind: 'profile', user: a, url: `${BASE}/${a}/` }
}

function _nums(s) {
    const grab = (label) => {
        const m = String(s || '').match(new RegExp(`([\\d.,]+[KMB]?)\\s+${label}`, 'i'))
        if (!m) return 0
        const raw = m[1]
        const mult = /k/i.test(raw) ? 1e3 : /m/i.test(raw) ? 1e6 : /b/i.test(raw) ? 1e9 : 1
        return Math.round(parseFloat(raw.replace(/[,]/g, '')) * mult)
    }
    return { followers: grab('followers'), following: grab('following'), posts: grab('posts') }
}

function _normHit(r) {
    const url = String(r.unescapedUrl || r.url || '')
    const k = _urlKind(url)
    const snip = String(r.contentNoFormatting || '').replace(/\s+/g, ' ').trim()
    const mt = r.richSnippet?.metatags || {}
    const thumb = r.richSnippet?.cseThumbnail?.src || r.richSnippet?.cseImage?.src || ''
    const base = { title: r.titleNoFormatting || '', snippet: snip, thumbnail: thumb }
    if (k.kind === 'profile') {
        const n = _nums(snip)
        return {
            ...base, type: 'profile', username: k.user, url: `${BASE}/${k.user}/`,
            name: mt.profileFirstName || (r.titleNoFormatting || '').replace(/\s*\(@[^)]*\)\s*$/, ''),
            followers: n.followers, following: n.following, posts: n.posts,
            followersLabel: n.followers ? _compact(n.followers) : '',
        }
    }
    if (k.kind === 'post' || k.kind === 'reel') {
        const form = k.kind === 'post' ? 'p' : 'reel'
        return { ...base, type: k.kind, shortcode: k.code, url: `${BASE}/${form}/${k.code}/`, author: (snip.match(/^([\w.]+)/) || [])[1] || '' }
    }
    if (k.kind === 'hashtag') return { ...base, type: 'hashtag', tag: k.tag, url: `${BASE}/explore/tags/${k.tag}/` }
    if (k.kind === 'story') return { ...base, type: 'story', username: k.user, url: `${BASE}/stories/${k.user}/` }
    return null
}

export async function search(keyword, { limit = 20, type = 'all', page = 1 } = {}) {
    const q = String(keyword || '').trim()
    if (!q) throw new Error('keyword search wajib diisi. Contoh: search "keraton"')
    const want = type === 'all' ? null : type
    const key = `${q}|${limit}|${type}|${page}`
    const hit = _cseRes.get(key)
    if (hit && Date.now() - hit.at < _CSE_TTL) return { ...hit.data, cached: true }
    const perPage = 10
    const maxPages = Math.max(1, Math.min(Math.ceil(limit / perPage), 8))
    const out = []
    const seen = new Set()
    let estimate = 0

    for (let i = 0; i < maxPages; i++) {
        const start = (page - 1) * maxPages * perPage + i * perPage
        let j
        try {
            j = await _cseRaw(q, start)
        } catch (e) {
            if (e.code && e.code !== 429) {
                _cseTok.at = 0
                j = await _cseRaw(q, start, true)
            } else throw e
        }
        const hits = j.results || []
        if (!hits.length) break
        if (!i) estimate = Number(String(j.cursor?.estimatedResultCount || '0').replace(/[^\d]/g, '')) || 0
        for (const r of hits) {
            const n = _normHit(r)
            if (!n) continue
            if (want && n.type !== want) continue
            const key = `${n.type}:${n.username || n.shortcode || n.tag || ''}`.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            out.push(n)
            if (out.length >= limit) break
        }
        if (out.length >= limit || hits.length < perPage) break
        await sleep(_CSE_GAP)
    }

    const result = {
        status: 'success',
        keyword: q,
        type: type || 'all',
        page,
        estimatedTotal: estimate,
        counts: {
            profile: out.filter(x => x.type === 'profile').length,
            post: out.filter(x => x.type === 'post').length,
            reel: out.filter(x => x.type === 'reel').length,
            hashtag: out.filter(x => x.type === 'hashtag').length,
            story: out.filter(x => x.type === 'story').length,
        },
        results: out,
        note: 'Search memakai indeks publik, jadi yang baru diposting belum muncul, dan Highlight tidak terindeks. Hasil profil/post bisa langsung dipakai buat mode lain.',
        watermark: 'VenzioLûx — Vloûte Cataclysm',
    }

    if (_cseRes.size > 60) _cseRes.delete(_cseRes.keys().next().value)
    _cseRes.set(key, { at: Date.now(), data: result })
    return result
}

function _asStory(t) {
    return { kind: 'story', user: t.user || t.code, url: `${BASE}/stories/${t.user || t.code}/` }
}

export async function info(input) {
    const t = resolveTarget(input)
    const clean = ({ _raw, _media, _igm, _sfi, ...rest }) => rest
    if (t.kind === 'story') return clean(await _kolStoryInfo(t))
    try {
        return clean(await _nativeInfo(t))
    } catch (e) {
        if (t.ambiguous) {
            const s = _asStory(t)
            try { return clean(await _kolStoryInfo(s)) } catch { }
        }
        try { return clean(await _engage(await _sfiInfo(t), t.url)) } catch { throw e }
    }
}

//download
async function _get(url, hdr = HDR_CDN, tries = 3) {
    let last = ''
    for (let i = 0; i < tries; i++) {
        try {
            const ctrl = new AbortController()
            const t = setTimeout(() => ctrl.abort(), 90000)
            const res = await fetch(url, { headers: hdr, signal: ctrl.signal })
            clearTimeout(t)
            if (res.status === 403) throw new Error('URL CDN kedaluwarsa. Jalankan ulang.')
            if (!res.ok) { last = `HTTP ${res.status}`; await sleep(600 * (i + 1)); continue }
            const buf = Buffer.from(await res.arrayBuffer())
            if (buf.length > 512) return buf
            last = `respons kosong (${buf.length}b)`
        } catch (e) { last = e.message; await sleep(600 * (i + 1)) }
    }
    throw new Error(`gagal unduh dari CDN (${last}).`)
}

const _videoUrl = (it, raw) => {
    if (it.videos?.length) return it.videos[it.videos.length - 1].url
    const dash = _dashMpd(raw).videos
    if (dash.length) return dash[0].url
    throw new Error('item ini gak punya video.')
}

async function _sfiMeta(t) {
    const { _raw, _media, ...meta } = await _sfiInfo(t)
    const { _igm, _sfi, ...rest } = await _engage(meta, t.url)
    return rest
}

async function _sfiVideo(t, hd) {
    const d = await _sfiSolve(t.url)
    const pick = d.items.find(x => x.kind === 'video') || d.items[0]
    if (!pick?.url) throw new Error('savefromins tidak mengembalikan URL video untuk target ini.')
    const buffer = await _get(pick.url, { ...HDR_CDN, referer: BASE + '/' })
    return {
        ...await _sfiMeta(t),
        buffer, ext: 'mp4', mimetype: 'video/mp4', ffmpeg: false,
        quality: `${pick.quality} H.264+AAC${hd ? ' (HD hanya dari Instagram, jadi dilewati)' : ''}`,
    }
}

export async function videoBuffer(input, { hd = false } = {}) {
    const t = resolveTarget(input)
    if (t.kind === 'story') return _kolStoryVideo(_asStory(t), hd)
    try {
        const ex = await _nativeInfo(t)
        if (ex.type !== 'video' && ex.type !== 'reel') throw new Error(`post ini ${ex.type}, bukan video. Pakai mode photo.`)
        if (hd && _hasFF) {
            const { videos, audios } = _dashMpd(ex._raw)
            const aud = audios[0]
            if (!videos.length || !aud?.url) throw new Error('post ini gak punya stream DASH (HD gak tersedia).')
            const [vb, ab] = await Promise.all([_get(videos[0].url), _get(aud.url)])
            return { buffer: _mux(vb, ab), ext: 'mp4', mimetype: 'video/mp4', ffmpeg: true, quality: `${videos[0].height}p VP9`, ..._slim(ex) }
        }
        const buf = await _get(_videoUrl(ex.items[0], ex._raw))
        return { buffer: buf, ext: 'mp4', mimetype: 'video/mp4', ffmpeg: false, quality: hd ? 'progressive (ffmpeg tidak ada, HD dilewati)' : 'progressive 720p', ..._slim(ex) }
    } catch (e) {
        try { return await _sfiVideo(t, hd) } catch { throw e }
    }
}

async function _sfiAudio(t, mp3) {
    const d = await _sfiSolve(t.url)
    const item = d.items.find(x => x.kind === 'video') || d.items[0]
    const pick = item?.variants?.find(v => v.muxed)
    if (!pick?.url) throw new Error('savefromins tidak memberi file video yang audio-nya sudah nempel, jadi audio ga bisa diekstrak.')
    const raw = await _get(pick.url, { ...HDR_CDN, referer: BASE + '/' })
    if (!_hasFF) throw new Error('mode audio harus ekstrak pakai ffmpeg, dan ffmpeg tidak ada di sistem ini. Pakai mode mp4 aja.')
    const args = mp3 ? ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'] : ['-vn', '-c:a', 'copy', '-movflags', '+faststart']
    return {
        ...await _sfiMeta(t),
        buffer: _ff({ buffer: raw, ext: 'mp4' }, args, mp3 ? 'mp3' : 'm4a'),
        ext: mp3 ? 'mp3' : 'm4a', mimetype: mp3 ? 'audio/mpeg' : 'audio/mp4', ffmpeg: true,
    }
}

export async function audioBuffer(input, { mp3 = false } = {}) {
    const t = resolveTarget(input)
    if (t.kind === 'story') return _kolStoryAudio(_asStory(t), mp3)
    try {
        const ex = await _nativeInfo(t)
        const { audios } = _dashMpd(ex._raw)
        if (!audios.length) throw new Error('post ini gak punya track audio.')
        const raw = await _get(audios[0].url)
        const kbps = Math.round(audios[0].bandwidth / 1000)
        if (!mp3) return { buffer: raw, ext: 'm4a', mimetype: 'audio/mp4', ffmpeg: false, kbps, ..._slim(ex) }
        if (!_hasFF) throw new Error('mode mp3 butuh ffmpeg, dan ffmpeg gak ada di sistem ini. Pakai mode audio (m4a) aja.')
        return { buffer: _ff({ buffer: raw, ext: 'm4a' }, ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'], 'mp3'), ext: 'mp3', mimetype: 'audio/mpeg', ffmpeg: true, kbps, ..._slim(ex) }
    } catch (e) {
        try { return await _sfiAudio(t, mp3) } catch { throw e }
    }
}

export async function photoBuffers(input) {
    const t = resolveTarget(input)
    if (t.kind === 'story') throw new Error('target ini story, bukan foto. Pakai mode story.')
    try {
        const ex = await _nativeInfo(t)
        if (ex.type !== 'photo' && ex.type !== 'carousel') throw new Error(`post ini ${ex.type}, bukan foto. Pakai mode mp4/hd.`)
        const items = []
        const skipped = []
        for (const it of ex.items) {
            const pick = it.images?.[0]
            if (!pick) { skipped.push({ index: it.index, kind: it.kind }); continue }
            items.push({ index: it.index, buffer: await _get(pick.url), url: pick.url, width: pick.width, height: pick.height, ext: 'jpg', mimetype: 'image/jpeg' })
        }
        if (!items.length) throw new Error('gak nemu URL foto di post ini.')
        return { items, skipped, ..._slim(ex) }
    } catch (e) {
        const d = await _sfiSolve(t.url)
        const photos = d.items.filter(x => x.kind === 'image' || /\.(jpe?g|png|webp)(\?|$)/i.test(x.url))
        if (!photos.length) throw e
        const items = []
        for (const p of photos) items.push({ index: p.index, buffer: await _get(p.url, { ...HDR_CDN, referer: BASE + '/' }), url: p.url, width: 0, height: 0, quality: p.quality, ext: 'jpg', mimetype: 'image/jpeg' })
        return { items, skipped: [], type: d.kind, url: `${BASE}/p/${t.code}/`, author: { username: d.author, url: d.author ? `${BASE}/${d.author}/` : '' }, caption: d.title === 'Instagram' ? '' : d.title, count: items.length, qualities: photos.map(p => ({ label: p.quality || 'original', width: 0, height: 0, kbps: 0, codec: 'jpeg' })) }
    }
}

export async function storyBuffers(input, { all = true } = {}) {
    let t = resolveTarget(input)
    if (t.kind !== 'story' && t.ambiguous) t = _asStory(t)
    if (t.kind !== 'story') throw new Error('mode story butuh URL /stories/<username>/, misalnya https://www.instagram.com/stories/nasa/')
    const d = await _kolSolve(t.url)
    const picked = all ? d.items : d.items.slice(0, 1)
    if (!picked.length) throw new Error('kol.id gak mengembalikan item untuk akun ini. Mungkin ga ada story aktif, atau privatenya belum diizinkan.')
    const items = []
    for (const [i, m] of picked.entries()) {
        const buffer = await _get(m.url, { ...HDR_CDN, referer: KOL + '/' })
        items.push({ index: i + 1, buffer, url: m.url, kind: m.kind, ext: m.kind === 'image' ? 'jpg' : 'mp4', mimetype: m.kind === 'image' ? 'image/jpeg' : 'video/mp4' })
    }
    return { items, author: d.author || t.user, user: t.user }
}

export async function coverBuffer(input) {
    const t = resolveTarget(input)
    if (t.kind === 'story') {
        const d = await _sfiSolve(t.url)
        const pick = d.items.find(x => x.thumbnail) || d.items[0]
        const url = pick?.thumbnail || pick?.url || d.thumbnail
        if (!url) throw new Error('gak nemu cover di target ini.')
        return { ...await _sfiMeta(t), buffer: await _get(url, { ...HDR_CDN, referer: BASE + '/' }), ext: 'jpg', mimetype: 'image/jpeg' }
    }
    try {
        const ex = await _nativeInfo(t)
        const first = ex.items.find(i => i.images?.length)
        const pick = first?.images?.[first.images.length - 1]
        const url = pick?.url || ex.author.profilePic
        if (!url) throw new Error('gak nemu cover di post ini.')
        return { buffer: await _get(url), ext: 'jpg', mimetype: 'image/jpeg', ..._slim(ex) }
    } catch (e) {
        const d = await _sfiSolve(t.url)
        const pick = d.items.find(x => x.thumbnail) || d.items.find(x => x.kind === 'image') || d.items[0]
        const url = pick?.thumbnail || pick?.url || d.thumbnail
        if (!url) throw e
        return { ...await _sfiMeta(t), buffer: await _get(url, { ...HDR_CDN, referer: BASE + '/' }), ext: 'jpg', mimetype: 'image/jpeg' }
    }
}

//ffmpeg
const _tmp = () => path.join(os.tmpdir(), `igvox-${Date.now()}-${Math.random().toString(36).slice(2)}`)

function _ff(input, outArgs, outExt, extraInputs = []) {
    const dir = _tmp()
    fs.mkdirSync(dir, { recursive: true })
    try {
        const parts = [...extraInputs, input]
        const ins = parts.map((p, i) => {
            const f = path.join(dir, `in${i}.${p.ext}`)
            fs.writeFileSync(f, p.buffer)
            return ['-i', f]
        })
        const outF = path.join(dir, `out.${outExt}`)
        const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...ins.flat(), ...outArgs, outF], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 300000 })
        if (r.status !== 0 || !fs.existsSync(outF)) throw new Error('ffmpeg gagal proses file.')
        const buf = fs.readFileSync(outF)
        if (buf.length < 512) throw new Error('hasil ffmpeg kosong.')
        return buf
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { } }
}

const _mux = (videoBuf, audioBuf) => _ff({ buffer: audioBuf, ext: 'm4a' }, ['-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart'], 'mp4', [{ buffer: videoBuf, ext: 'mp4' }])

const _slim = (ex) => {
    const { items, _raw, _media, _igm, _sfi, ...rest } = ex
    return rest
}

//CLI
const _safe = (s) => String(s || 'instagram').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'instagram'

const _who = (r) => r?.author?.username || r?.author?.fullName || (typeof r?.author === 'string' ? r.author : '') || r?.user || ''

const _base = (r) => {
    const who = _who(r)
    if (who) return _safe(who)
    const cap = String(r?.caption || '').replace(/https?:\/\/\S+/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ')
    return _safe(cap)
}

function _out(given, fallback, ext) {
    if (!given) return fallback
    return path.extname(given) ? given : `${given}.${ext}`
}

function _outName(given, fallback, index, total, ext) {
    if (!given) return total > 1 ? `${fallback}_${index}.${ext}` : `${fallback}.${ext}`
    const e = path.extname(given)
    const stem = e ? given.slice(0, -e.length) : given
    const gext = e ? e.slice(1) : ext
    return total > 1 ? `${stem}_${index}.${gext}` : given
}

if (process.argv[1] && import.meta.url.endsWith('/' + path.basename(process.argv[1]))) {
    const [, , a1, a2, a3, a4] = process.argv
    const emit = (r, extra) => {
        const { items, buffer, _raw, _media, _igm, _sfi, ...rest } = r
        const out = { status: 'success', watermark: 'VenzioLûx — Vloûte Cataclysm', ...rest, ...extra }
        if (items) out.filesMeta = items.map(i => ({ index: i.index, ext: i.ext, width: i.width, height: i.height, url: i.url }))
        console.log(JSON.stringify(out, null, 2))
    }
    const mb = (n) => ({ bytes: n, mb: +(n / 1048576).toFixed(2) })

    try {
        if (!a1 || a1 === 'help' || a1 === '-h' || a1 === '--help') {
            console.log('Instagram scraper — post, reel, carousel, story, dan search. Tanpa login, tanpa cookie.')
            console.log('')
            console.log('pakai: node igVox.mjs <url|shortcode> [mode] [output]')
            console.log('       node igVox.mjs search <keyword> [limit] [page]')
            console.log('')
            console.log('  info    metadata JSON (default)')
            console.log('  mp4     video progressive H.264 720p')
            console.log('  hd      video DASH VP9 sampai 1440p (butuh ffmpeg, auto-fallback ke 720p)')
            console.log('  mp3     audio MP3 (butuh ffmpeg)')
            console.log('  audio   audio m4a apa adanya (tanpa ffmpeg)')
            console.log('  photo   semua foto carousel: nama_1.jpg, nama_2.jpg, ...')
            console.log('  story   SEMUA story aktif: /stories/<user>/ -> user_1.mp4, ...')
            console.log('  cover   satu gambar sampul')
            console.log('')
            console.log('  search  cari profil / post / reel / hashtag lewat indeks publik')
            console.log('')
            console.log('contoh: node igVox.mjs search "keraton" 20')
            console.log('        node igVox.mjs https://www.instagram.com/reel/DV3dfTYjZVj/ hd starship.mp4')
            console.log('        node igVox.mjs https://www.instagram.com/stories/nasa/ story nasa_story')
            process.exit(0)
        } else if (a1 === 'search') {
            const t0 = Date.now()
            const r = await search(a2, { limit: Math.min(Number(a3) || 20, 80), page: Math.max(Number(a4) || 1, 1) })
            console.log(JSON.stringify({ ...r, timeSec: +((Date.now() - t0) / 1000).toFixed(2) }, null, 2))
        } else if (a2 === 'mp4' || a2 === 'hd') {
            const t0 = Date.now(); const r = await videoBuffer(a1, { hd: a2 === 'hd' })
            const f = _out(a3, `${_base(r)}_${r.duration || 0}s.${r.ext}`, r.ext)
            fs.writeFileSync(f, r.buffer)
            emit(r, { file: f, size: mb(r.buffer.length), timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else if (a2 === 'mp3' || a2 === 'audio') {
            const t0 = Date.now(); const r = await audioBuffer(a1, { mp3: a2 === 'mp3' })
            const f = _out(a3, `${_base(r)}.${r.ext}`, r.ext)
            fs.writeFileSync(f, r.buffer)
            emit(r, { file: f, size: mb(r.buffer.length), ffmpeg: r.ffmpeg, timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else if (a2 === 'photo') {
            const t0 = Date.now(); const r = await photoBuffers(a1); const files = []
            for (const it of r.items) { const f = _outName(a3, _base(r), it.index, r.items.length, it.ext); fs.writeFileSync(f, it.buffer); files.push({ index: it.index, file: f, size: mb(it.buffer.length), width: it.width, height: it.height }) }
            emit(r, { files, count: files.length, timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else if (a2 === 'story') {
            const t0 = Date.now(); const r = await storyBuffers(a1); const files = []
            for (const it of r.items) { const f = _outName(a3, _base(r), it.index, r.items.length, it.ext); fs.writeFileSync(f, it.buffer); files.push({ index: it.index, file: f, kind: it.kind, size: mb(it.buffer.length) }) }
            emit(r, { files, count: files.length, user: r.user, timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else if (a2 === 'cover') {
            const t0 = Date.now(); const r = await coverBuffer(a1); const f = _out(a3, `${_base(r)}_cover.jpg`, r.ext)
            fs.writeFileSync(f, r.buffer)
            emit(r, { file: f, size: mb(r.buffer.length), timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else {
            const { _media, ...meta } = await info(a1)
            console.log(JSON.stringify({ status: 'success', watermark: 'VenzioLûx — Vloûte Cataclysm', ...meta }, null, 2))
        }
    } catch (e) {
        console.error('GAGAL:', e.message)
        process.exit(1)
    }
}