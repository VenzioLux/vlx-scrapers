/*
Base    : https://www.tiktok.com (resolver: tikwm.com)
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Alternatif tikMw: search + download lewat resolver TikWM
- Search beneran TikTok (keyword, paging cursor) — jalan dari IP datacenter,
  sementara API web TikTok balas kosong ke IP datacenter
- LivePhoto: motion asli (live_images) buat post foto/carousel, plus still
- Video (pilihan no-watermark/watermark), audio, foto, slide->MP4
- Nol proxy, nol cookie akun, nol dependency, Node >= 18
- Base URL TikWM: garis miring di akhir path WAJIB (/api/feed/search/ bukan
  /api/feed/search) — tanpa itu Cloudflare balas 403
- Semua output CLI = JSON (gampang ditelan bot/API, tinggal parse)
- Catatan: hasil search belum membawa gambar/LivePhoto. Kalau butuh motion,
  panggil mode info/live dengan URL hasil search itu

Usage:
  node tikAlt.mjs search "<keyword>" [jumlah]   cari video
  node tikAlt.mjs <url|id>                     metadata JSON
  node tikAlt.mjs <url|id> mp4 [watermark]     video (default no-watermark)
  node tikAlt.mjs <url|id> mp3 [output]        audio (pakai ffmpeg opsional)
  node tikAlt.mjs <url|id> audio [output]     audio apa adanya (m4a)
  node tikAlt.mjs <url|id> photo [output]     semua gambar
  node tikAlt.mjs <url|id> live [output]      motion LivePhoto
  node tikAlt.mjs <url|id> slide [output]     foto+motion -> 1 video MP4
*/

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const API = 'https://www.tikwm.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const HDRS = {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    referer: 'https://www.tikwm.com/',
    origin: 'https://www.tikwm.com',
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const _hasFF = (() => { try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 } catch { return false } })()
const _cache = new Map()
const _TTL = 5 * 60_000

//api
async function _api(pathname, params = {}, tries = 4) {
    const qs = new URLSearchParams(params).toString()
    const url = `${API}${pathname}${qs ? '?' + qs : ''}`
    let last = ''
    for (let i = 0; i < tries; i++) {
        try {
            const ctrl = new AbortController()
            const t = setTimeout(() => ctrl.abort(), 30000)
            const res = await fetch(url, { headers: HDRS, signal: ctrl.signal })
            clearTimeout(t)
            const txt = await res.text()
            if (res.status === 200 && txt.trim().startsWith('{')) {
                const d = JSON.parse(txt)
                if (d.code === 0) return d.data
                last = d.msg || `code ${d.code}`
            } else last = `HTTP ${res.status}`
        } catch (e) { last = e.message }
        await sleep(700 * (i + 1))
    }
    throw new Error(`resolver TikWM gak bisa jawab (${last}). Link-nya cek lagi, atau coba beberapa menit lagi.`)
}

//search
export async function search(keyword, { count = 20, watermark = false } = {}) {
    const q = String(keyword || '').trim()
    if (!q) throw new Error('keyword kosong.')
    const out = []
    const seen = new Set()
    let cursor = 0
    while (out.length < count && cursor < count * 2) {
        const d = await _api('/api/feed/search/', { keywords: q, count: 30, cursor, HD: 1 })
        const vids = d?.videos || []
        if (!vids.length) break
        for (const v of vids) {
            const id = v.video_id || v.id
            if (!id || seen.has(id)) continue
            seen.add(id)
            out.push(_norm(id, v, watermark))
            if (out.length >= count) break
        }
        cursor += 30
        await sleep(900)
    }
    if (!out.length) throw new Error(`keyword "${q}" gak ada hasilnya di TikTok.`)
    return { keyword: q, count: out.length, source: 'tiktok (via tikwm)', items: out }
}

function _norm(id, v, watermark) {
    return {
        id,
        type: (v.images || []).length ? 'photo' : 'video',
        title: (v.title || '').split('\n')[0].slice(0, 200),
        url: `https://www.tiktok.com/@${v.author?.unique_id || 'i'}/${(v.images || []).length ? 'photo' : 'video'}/${id}`,
        author: {
            uniqueId: v.author?.unique_id || '', nickname: v.author?.nickname || '',
            avatar: v.author?.avatar || '', signature: v.author?.signature || '',
        },
        duration: Number(v.duration) || 0,
        createTime: Number(v.create_time) || 0,
        createdAt: v.create_time ? new Date(Number(v.create_time) * 1000).toISOString() : null,
        stats: {
            playCount: v.play_count || 0, likeCount: v.digg_count || 0,
            commentCount: v.comment_count || 0, shareCount: v.share_count || 0,
            collectCount: v.collect_count || 0,
        },
        music: { title: v.music_info?.title || '', author: v.music_info?.authorName || '', url: v.music_info?.play || v.music || '' },
        thumbnail: v.cover || v.origin_cover || '',
        images: v.images || [],
        liveImages: v.live_images || [],
        video: {
            url: (watermark ? (v.wmplay || v.play) : (v.hdplay || v.play)) || '',
            watermarkUrl: v.wmplay || '',
            size: Number(v.hd_size || v.size) || 0,
        },
    }
}

//resolve
export async function resolveTarget(raw) {
    let s = String(raw || '').trim()
    if (!s) return null
    if (/^\d{15,20}$/.test(s)) s = `https://www.tiktok.com/@i/video/${s}`
    else if (!/^https?:\/\//i.test(s)) {
        if (/^((www|m|vt|vm|v)\.)?tiktok\.com(\/|$)/i.test(s)) s = 'https://' + s
        else return null
    }
    return s
}

export async function info(input) {
    const url = await resolveTarget(input)
    if (!url) throw new Error('gak bisa baca link ini. Pakai link tiktok.com/@user/video|photo/id, short link vt./vm., atau ID polos.')
    const key = 'i:' + url
    if (_cache.has(key) && Date.now() - _cache.get(key).at < _TTL) return _cache.get(key).data
    const d = await _api('/api/', { url, hd: 1 })
    const v = Array.isArray(d) ? d[0] : d
    const id = v?.video_id || v?.id
    if (!id) throw new Error('post ini gak ketemu di TikTok. Cek link-nya, atau kalo post-nya private/deleted ya memang gak bisa.')
    const ex = _norm(id, v, false)
    ex.liveCount = ex.liveImages.length
    ex.isLive = ex.liveCount > 0
    ex.size = { bytes: ex.video.size || 0 }
    if (_cache.size > 60) _cache.delete(_cache.keys().next().value)
    _cache.set(key, { at: Date.now(), data: ex })
    return ex
}

//download (CDN TikWM tanpa signature & tanpa User-Agent)
const _CHUNK = 6 * 1024 * 1024

async function _get(url, start, end, tries = 4) {
    for (let i = 0; i < tries; i++) {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 60000)
        try {
            const headers = { referer: 'https://www.tikwm.com/', ...(start != null ? { range: `bytes=${start}-${end}` } : {}) }
            const res = await fetch(url, { headers, signal: ctrl.signal })
            if (res.status !== 200 && res.status !== 206) { clearTimeout(t); continue }
            const total = Number(String(res.headers.get('content-range') || '').split('/')[1]) || 0
            const buf = Buffer.from(await res.arrayBuffer())
            clearTimeout(t)
            if (buf.length) return { buf, total }
        } catch { clearTimeout(t) }
        await sleep(500 * (i + 1))
    }
    throw new Error('gagal ambil file dari CDN TikTok. Coba lagi beberapa saat.')
}

export async function downloadStream(urlIn, { timeout = 240000 } = {}) {
    if (!urlIn) throw new Error('URL file kosong.')
    const probe = await _get(urlIn, 0, 0)
    const total = probe.total
    if (!total || total <= _CHUNK * 2) return (await _get(urlIn, null, null)).buf
    const n = Math.min(8, Math.ceil(total / _CHUNK))
    const parts = await Promise.allSettled(
        Array.from({ length: n }, (_, i) => {
            const s = i * _CHUNK
            return _get(urlIn, s, Math.min(s + _CHUNK - 1, total - 1))
        })
    )
    const got = parts.filter(p => p.status === 'fulfilled').map(p => p.value)
    if (got.length === n && got.reduce((a, p) => a + p.buf.length, 0) === total) {
        return Buffer.concat(got.map(p => p.buf))
    }
    return (await _get(urlIn, null, null)).buf
}

// buffers
export async function videoBuffer(input, { watermark = false } = {}) {
    const ex = await info(input)
    if (ex.type === 'photo') throw new Error('post ini photo/carousel — pakai mode photo, live, atau slide.')
    const url = watermark ? (ex.video.watermarkUrl || ex.video.url) : ex.video.url
    const buffer = await downloadStream(url)
    return { buffer, ...ex, ext: 'mp4', mimetype: 'video/mp4' }
}

export async function audioBuffer(input, { mp3 = true } = {}) {
    const ex = await info(input)
    const url = ex.music?.url
    if (!url) throw new Error('post ini gak ada musik (sound original).')
    let buffer = (await _get(url, null, null)).buf
    let ext = 'm4a'
    if (mp3) {
        if (!_hasFF) return { buffer, ...ex, ext: 'm4a', mimetype: 'audio/mp4' }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttalt-'))
        try {
            const inF = path.join(dir, 'a.m4a'), outF = path.join(dir, 'a.mp3')
            fs.writeFileSync(inF, buffer)
            const r = spawnSync('ffmpeg', ['-y', '-i', inF, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', outF], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 90000 })
            if (r.status === 0 && fs.existsSync(outF)) { buffer = fs.readFileSync(outF); ext = 'mp3' }
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { } }
    }
    return { buffer, ...ex, ext, mimetype: ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4', ffmpeg: _hasFF }
}

export async function photoBuffers(input) {
    const ex = await info(input)
    if (!ex.images.length) throw new Error('post ini gak punya gambar (bukan photo/carousel).')
    const items = []
    for (let i = 0; i < ex.images.length; i++) {
        const buffer = (await _get(ex.images[i], null, null)).buf
        const isLive = !!ex.liveImages[i]
        items.push({ index: i + 1, buffer, url: ex.images[i], live: isLive, liveUrl: ex.liveImages[i] || '', ext: 'jpg', mimetype: 'image/jpeg' })
    }
    return { items, ...ex }
}

export async function liveBuffers(input) {
    const ex = await info(input)
    if (!ex.liveImages.length) throw new Error('post ini bukan LivePhoto (tidak ada motion). LivePhoto cuma ada di app TikTok.')
    const items = []
    for (let i = 0; i < ex.liveImages.length; i++) {
        const buffer = (await _get(ex.liveImages[i], null, null)).buf
        items.push({ index: i + 1, buffer, url: ex.liveImages[i], still: ex.images[i] || '', ext: 'mp4', mimetype: 'video/mp4' })
    }
    return { items, ...ex }
}

// foto + motion -> 1 video MP4
export async function slideBuffer(input, { perSec = 3 } = {}) {
    if (!_hasFF) throw new Error('mode slide butuh ffmpeg, dan ffmpeg gak ada di sistem ini. Pakai mode photo atau live aja.')
    const ex = await info(input)
    if (!ex.images.length) throw new Error('post ini gak punya gambar (bukan photo/carousel).')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttalt-src-'))
    try {
        const parts = []
        let liveCount = 0
        for (let i = 0; i < ex.images.length; i++) {
            const live = ex.liveImages[i]
            const buf = (await _get(live || ex.images[i], null, null)).buf
            const p = path.join(dir, `s${String(i).padStart(3, '0')}.${live ? 'mp4' : 'jpg'}`)
            fs.writeFileSync(p, buf)
            if (live) liveCount++
            parts.push({ p, live: !!live })
        }
        let audio = null
        if (ex.music?.url) { try { audio = (await _get(ex.music.url, null, null)).buf } catch { } }
        const buffer = _slideshow(parts, audio, perSec)
        return { buffer, ...ex, ext: 'mp4', mimetype: 'video/mp4', slides: parts.length, liveSlides: liveCount, slideDurationSec: perSec, withMusic: !!audio }
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { } }
}

function _slideshow(parts, audio, perStill) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttalt-slide2-'))
    try {
        const list = parts.map(f => `file '${f.p}'${f.live ? `\nduration 2.7` : `\nduration ${perStill}`}`).join('\n') + `\nfile '${parts[parts.length - 1].p}'\n`
        const listF = path.join(dir, 'list.txt')
        fs.writeFileSync(listF, list)
        const out = path.join(dir, 'out.mp4')
        const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listF]
        if (audio) { const af = path.join(dir, 'a.m4a'); fs.writeFileSync(af, audio); args.push('-i', af) }
        args.push('-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p')
        if (audio) args.push('-c:a', 'aac', '-shortest')
        args.push(out)
        const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 240000 })
        if (r.status !== 0 || !fs.existsSync(out)) throw new Error('ffmpeg gagal merangkai slide (exit ' + r.status + ')')
        return fs.readFileSync(out)
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { } }
}

//CLI
const _safe = (s) => String(s || 'tiktok').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'tiktok'

function _outName(given, fallback, index, total, ext) {
    if (!given) return total > 1 ? `${fallback}_${index}.${ext}` : `${fallback}.${ext}`
    const e = path.extname(given)
    const stem = e ? given.slice(0, -e.length) : given
    const gext = e ? e.slice(1) : ext
    return total > 1 ? `${stem}_${index}.${gext}` : given
}

if (process.argv[1] && import.meta.url.endsWith('/' + path.basename(process.argv[1]))) {
    const [, , a1, a2, a3] = process.argv
    const emit = (r, extra) => { const { buffer, items, ...rest } = r; if (items) rest.filesMeta = items.map(i => ({ index: i.index, ext: i.ext, live: !!i.live, url: i.url })); console.log(JSON.stringify({ status: 'success', ...rest, ...extra }, null, 2)) }

    try {
        if (a1 === 'search') {
            if (!a2) { console.log('pakai: node tikAlt.mjs search "<keyword>" [jumlah]'); process.exit(0) }
            const count = Number(a3) || 20
            const r = await search(a2, { count })
            console.log(JSON.stringify({ status: 'success', query: r.keyword, count: r.count, source: r.source, items: r.items }, null, 2))
        } else if (!a1) {
            console.log('pakai: node tikAlt.mjs <url|id> [info|mp4|mp3|audio|photo|live|slide] [output]')
            console.log('       node tikAlt.mjs search "<keyword>" [jumlah]')
            process.exit(0)
        } else if (a2 === 'mp4') {
            const t0 = Date.now(); const r = await videoBuffer(a1, { watermark: a3 === 'watermark' })
            const f = (a3 && a3 !== 'watermark') ? a3 : `${_safe(r.title)}_${r.duration}s.mp4`
            fs.writeFileSync(f, r.buffer); emit(r, { size: { bytes: r.buffer.length, mb: +(r.buffer.length / 1048576).toFixed(2) }, file: f, timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else if (a2 === 'mp3' || a2 === 'audio') {
            const t0 = Date.now(); const r = await audioBuffer(a1, { mp3: a2 === 'mp3' })
            const f = a3 || `${_safe(r.title)}.${r.ext}`
            fs.writeFileSync(f, r.buffer); emit(r, { size: { bytes: r.buffer.length }, file: f, ffmpeg: r.ffmpeg, timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else if (a2 === 'photo') {
            const t0 = Date.now(); const r = await photoBuffers(a1); const files = []
            for (const it of r.items) { const f = _outName(a3, _safe(r.title), it.index, r.items.length, it.ext); fs.writeFileSync(f, it.buffer); files.push({ index: it.index, file: f, size: { bytes: it.buffer.length }, live: it.live }) }
            emit(r, { files, totalBytes: files.reduce((a, b) => a + b.size.bytes, 0), timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else if (a2 === 'live') {
            const t0 = Date.now(); const r = await liveBuffers(a1); const files = []
            for (const it of r.items) { const f = _outName(a3, _safe(r.title) + '_live', it.index, r.items.length, 'mp4'); fs.writeFileSync(f, it.buffer); files.push({ index: it.index, file: f, size: { bytes: it.buffer.length } }) }
            emit(r, { files, timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else if (a2 === 'slide') {
            const t0 = Date.now(); const r = await slideBuffer(a1); const f = a3 || `${_safe(r.title)}_slide.mp4`
            fs.writeFileSync(f, r.buffer); emit(r, { size: { bytes: r.buffer.length, mb: +(r.buffer.length / 1048576).toFixed(2) }, file: f, timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else {
            console.log(JSON.stringify({ status: 'success', ...(await info(a1)) }, null, 2))
        }
    } catch (e) {
        console.error('GAGAL:', e.message)
        process.exit(1)
    }
}
