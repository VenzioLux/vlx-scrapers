#!/usr/bin/env node
/*
Base    : https://www.facebook.com (jalur plugins/video.php, tanpa login)
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Video/reel Facebook publik: HD + SD, tanpa login, cookie, API, maupun browser
- Cepet: dua halaman di-fetch persis bersamaan, cuma dibaca sampai data ketemu; download Range paralel 4 koneksi. 5.4MB < 1 detik
- Metadata: caption, nama halaman + link + verified badge, views, reactions, likes, comments, shares, tanggal, dimensi, gambar
- info = semua resolusi + bytes/size tiap resolusi (di-probe, bukan download). Mode download cuma bawa resolusi yang dipake + bytes/size/file/timeSec
- audio: mp3 = re-encode, m4a = copy stream AAC. Dua-duanya butuh ffmpeg
- Hanya video/reel + audio. FOTO TIDAK SUPPORT: halaman foto butuh login walau publik, dan embednya balik kosong (diverifikasi)
- FB ga ada search publik tanpa login, jadi input HARUS URL post. views/reaksi cuma format ringkas FB ("2.8J views") — presisi butuh login
- URL CDN FB ada signature kedaluwarsa. Kalau kena 403 pas download, ulangi command-nya

Usage:
  node fbFast.mjs <url>                 metadata JSON super lengkap (default)
  node fbFast.mjs <url> info            sama, eksplisit
  node fbFast.mjs <url> hd  [out.mp4]   video HD
  node fbFast.mjs <url> sd  [out.mp4]   video SD
  node fbFast.mjs <url> audio [out.m4a] audio M4A (butuh ffmpeg)
  node fbFast.mjs <url> mp3   [out.mp3] audio MP3 (butuh ffmpeg)
*/

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const BASE = 'https://www.facebook.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const WATERMARK = 'VenzioLûx — Vloûte Cataclysm'
const SOURCE = 'facebook'
const CONCURRENCY = 4
const CHUNK = 1048576


const HDR_PAGE = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not.A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
    'sec-fetch-user': '?1', 'upgrade-insecure-requests': '1',
}
const HDR_CDN = { 'user-agent': UA, referer: BASE + '/' }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const _hasFF = (() => { try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 } catch { return false } })()
const _size = (f) => { try { return fs.statSync(f).size } catch { return 0 } }

function help() {
    console.log(`Usage:
  node fbFast.mjs <url>                 metadata JSON super lengkap (default)
  node fbFast.mjs <url> info            sama, eksplisit
  node fbFast.mjs <url> hd  [out.mp4]   video HD
  node fbFast.mjs <url> sd  [out.mp4]   video SD
  node fbFast.mjs <url> audio [out.m4a] audio M4A (butuh ffmpeg)
  node fbFast.mjs <url> mp3   [out.mp3] audio MP3 (butuh ffmpeg)

Ex: node fbFast.mjs https://www.facebook.com/facebook/videos/10153231379946729/ hd fb.mp4`)
    process.exit(process.argv.length > 2 ? 0 : 1)
}

//url
function resolveTarget(input) {
    const s = String(input || '').trim()
    if (/^\d{10,}$/.test(s)) return { id: s, url: `${BASE}/video.php?v=${s}` }
    let u = s
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '')
    let host
    try { host = new URL(u).host } catch { throw new Error('URL-nya nggak valid.') }
    if (!/facebook\.com$|facebook\.com/i.test(host)) throw new Error('Bukan URL facebook.')
    return { url: u, id: '' }
}

//parse
const _unesc = (t) => t.replace(/\\\//g, '/').replace(/\\u0025/g, '%')
const _detag = (s) => s.replace(/&quot;/g, '"').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
const _og = (html) => {
    const o = {}
    for (const m of html.matchAll(/<meta (?:property|name)="og:([^"]*)" content="([^"]*)"/g)) o[m[1]] = _detag(m[2])
    return o
}

function _titleParts(t) {
    const s = String(t || '').replace(/&#x[0-9a-fA-F]+;/g, (m) => String.fromCharCode(parseInt(m.slice(3, -1), 16))).replace(/&amp;/g, '&')
    if (!s.includes('|')) return { views: '', reactions: '', caption: s, page: '' }
    const [head, ...rest] = s.split('|')
    const caption = rest[0]?.trim() || ''
    const page = rest[1]?.trim() || ''
    const eng = head.split('·').map(x => x.trim())
    return { views: eng[0] || '', reactions: eng[1] || '', caption, page }
}

function _engagement(html) {
    const m = html.match(/<table class="uiGrid[^"]*"[^>]*>([\s\S]*?)<\/table>/)
    if (!m) return { likes: null, comments: null, shares: null }
    const nums = [...m[1].matchAll(/<td[^>]*>[\s\S]*?>([\d.,]+[KJMT]?)</g)].map(x => x[1])
    return {
        likes: nums[0] ?? null,
        comments: nums[1] ?? null,
        shares: nums[2] ?? null,
    }
}

function _isVerified(html) {
    return /aria-label="(?:Verified[^"]{0,30}|Profil disahkan)"/i.test(html)
        || /\\"aria-label\\":\\"(?:Verified[^"]{0,30}|Profil disahkan)/i.test(html)
}

function _authorUrl(html, pageName) {
    const want = (pageName || '').trim()
    if (!want) return null
    for (const m of html.matchAll(/<a[^>]*href="(https:\/\/www\.facebook\.com\/[^"]{3,60})"[^>]*>([\s\S]{0,80}?)<\/a>/g)) {
        const u = m[1]
        const txt = m[2].replace(/<[^>]+>/g, '').trim()
        if (txt === want && !/\/(help|photo|video|watch|reel|plugins|story|sharer|dialog|permalink)/.test(u)) return u
    }
    return null
}

const _readUntil = async (url, done, limit = 900000) => {
    const r = await fetch(url, { headers: HDR_PAGE, redirect: 'follow' })
    if (!r.ok) throw new Error(`Facebook balas ${r.status} untuk ${url}`)
    const dec = new TextDecoder()
    let raw = '', n = 0
    for await (const chunk of r.body) {
        n += chunk.length
        raw += dec.decode(chunk, { stream: true })
        if (done.test(raw) || n > limit) break
    }
    await r.body.cancel().catch(() => { })
    return raw
}

const _untilOg = (url) => _readUntil(url, /"creation_time":\d+/)
const _untilVid = (url) => _readUntil(url, /"original_height":\d+[^}]*"original_width":\d+/)
const _embedUrl = (permalink) => `${BASE}/plugins/video.php?href=${encodeURIComponent(permalink)}&show_text=true&width=500`

function _videoSrc(html) {
    const f = _unesc(html)
    const pick = (k) => {
        const m = f.match(new RegExp('"' + k + '":"((?:[^"\\\\]|\\\\.)*)"'))
        return m ? _detag(m[1].replace(/\\\//g, '/')).replace(/\\u0025/g, '%') : ''
    }
    const hd = pick('hd_src'), sd = pick('sd_src')
    const w = +(f.match(/"original_width":(\d+)/) || [])[1] || 0
    const h = +(f.match(/"original_height":(\d+)/) || [])[1] || 0
    const kb = (u) => Number((u.match(/[?&]bitrate=(\d+)/) || [])[1]) || null
    return {
        hd, sd, width: w, height: h,
        aspectRatio: +(f.match(/"aspect_ratio":([\d.]+)/) || [])[1] || null,
        hdBitrate: kb(hd), sdBitrate: kb(sd),
        isLive: /"is_live_stream":true|"is_broadcast":true/.test(f),
    }
}

//resolve
export async function resolve(input) {
    const t = resolveTarget(input)
    const [postHtml, embedHtml] = await Promise.all([
        _untilOg(t.url), _untilVid(_embedUrl(t.url)),
    ])

    const og = _og(postHtml)
    if (!og.title && !og.url) throw new Error('Post ini nggak balas og:data. Kemungkinan: kena login-wall')

    const p = _titleParts(og.title)
    const flat = _unesc(postHtml)
    const ct = +(flat.match(/"creation_time":(\d+)/) || [])[1] || 0
    const canonical = og.url || t.url
    let embedHtml2 = embedHtml
    if (canonical !== t.url) {
        try { embedHtml2 = await _untilVid(_embedUrl(canonical)) } catch { embedHtml2 = embedHtml }
    }

    const v = _videoSrc(embedHtml2)
    const eng = _engagement(embedHtml2)
    const au = { url: _authorUrl(embedHtml2, p.page), verified: _isVerified(embedHtml2) }
    const type = /\/reel\//.test(canonical) ? 'reel' : (v.hd || v.sd) ? 'video' : 'post'
    const meta = {
        id: t.id || canonical.match(/\/(\d{10,})\/?(?:$|\?)/)?.[1] || '',
        url: canonical,
        type,
        ogType: og.type || null,
        caption: p.caption || _detag(og.description || ''),
        description: _detag(og.description || '') || null,
        author: { name: p.page || 'Facebook', url: au.url || '', verified: au.verified },
        engagement: {
            views: p.views || null,
            reactions: p.reactions || null,
            likes: eng.likes,
            comments: eng.comments,
            shares: eng.shares,
        },
        createdAt: ct ? new Date(ct * 1000).toISOString() : null,
        timestamp: ct || null,
        dimensions: v.width && v.height ? `${v.width}x${v.height}` : null,
        aspectRatio: v.aspectRatio,
        isLive: v.isLive,
        resolutions: [
            ...(v.hd ? [{ quality: 'hd', tag: 'hd_src', url: v.hd, bitrate: v.hdBitrate }] : []),
            ...(v.sd ? [{ quality: 'sd', tag: 'sd_src', url: v.sd, bitrate: v.sdBitrate }] : []),
        ],
    }

    return {
        ...meta,
        embedUrl: _embedUrl(canonical),
        permalink: canonical,
        _emb: v,
        _meta: meta,
        watermark: WATERMARK,
        source: SOURCE,
    }
}

//download
async function _probeSize(url) {
    try {
        const r = await fetch(url, { headers: { ...HDR_CDN, range: 'bytes=0-0' } })
        const n = Number(String(r.headers.get('content-range') || '').split('/')[1])
        return n > 0 ? n : null
    } catch { return null }
}

async function rangeGet(url, start, end, ctrl) {
    for (let i = 0; i < 3; i++) {
        try {
            const r = await fetch(url, {
                headers: { ...HDR_CDN, range: `bytes=${start}-${end}` },
                signal: AbortSignal.timeout(Math.max(4000, ctrl.left())),
            })
            if (r.status === 206 || r.status === 200) {
                const buf = Buffer.from(await r.arrayBuffer())
                if (buf.length) return buf
            }
            if (r.status === 403) throw new Error('403 — signature URL CDN kedaluwarsa')
        } catch (e) {
            if (e.message.includes('403')) throw e
            if (i === 2) throw e
            await sleep(300 * (i + 1))
        }
    }
    throw new Error('koneksi download gagal')
}

export async function downloadFast(url, out) {
    const probe = await fetch(url, { headers: { ...HDR_CDN, range: 'bytes=0-0' } })
    const total = Number(String(probe.headers.get('content-range') || '').split('/')[1]) || 0
    if (!total) {
        const r = await fetch(url, { headers: HDR_CDN })
        if (!r.ok) throw new Error(`Facebook CDN nolak download (${r.status}). URL-nya kedaluwarsa — ulangi command-nya.`)
        const ws = fs.createWriteStream(out)
        for await (const c of r.body) ws.write(c)
        ws.end()
        return _size(out)
    }

    const fd = fs.openSync(out, 'w')
    fs.ftruncateSync(fd, total)
    let pos = 0
    let failed = null
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
            if (failed) return
            const my = pos
            pos += CHUNK
            if (my >= total) return
            const end = Math.min(my + CHUNK, total) - 1
            try {
                const buf = await rangeGet(url, my, end, { left: () => 30000 })
                fs.writeSync(fd, buf, 0, buf.length, my)
            } catch (e) {
                failed = e.message
                return
            }
        }
    }))
    fs.closeSync(fd)
    if (failed) { fs.rmSync(out, { force: true }); throw new Error(`download gagal (${failed}). Kalau 403: URL CDN-nya kedaluwarsa, ulangi command-nya.`) }
    return total
}

export const info = (input) => resolve(input)

export async function videoBuffer(input, { hd = true } = {}) {
    const ex = await resolve(input)
    const v = ex._emb
    const pick = hd ? (v.hd || v.sd) : (v.sd || v.hd)
    if (!pick) throw new Error('post ini bukan video/reel, jadi nggak ada yang bisa diunduh.')
    const buf = await _cdn(pick)
    const { _emb, ...rest } = ex
    return { buffer: buf, ext: 'mp4', mimetype: 'video/mp4', quality: hd ? (v.hd ? 'hd_src' : 'sd_src (fallback)') : (v.sd ? 'sd_src' : 'hd_src'), ...rest }
}

export async function audioBuffer(input, { mp3 = false } = {}) {
    const ex = await resolve(input)
    const v = ex._emb
    if (!v.hd && !v.sd) throw new Error('post ini bukan video.')
    const raw = await _cdn(v.hd || v.sd)
    if (!mp3) return { buffer: raw, ext: 'm4a', mimetype: 'audio/mp4', ffmpeg: false, ...ex }
    if (!_hasFF) throw new Error('mode mp3 butuh ffmpeg, dan ffmpeg nggak ada di sistem ini. Pakai audio (m4a) aja.')
    const dir = path.join(os.tmpdir(), `fbf-${Date.now()}`)
    fs.mkdirSync(dir, { recursive: true })
    try {
        const a = path.join(dir, 'in.mp4'), b = path.join(dir, 'out.mp3')
        fs.writeFileSync(a, raw)
        const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', a, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', b], { stdio: 'ignore' })
        if (r.status !== 0) throw new Error('ffmpeg gagal ekstrak audio.')
        return { buffer: fs.readFileSync(b), ext: 'mp3', mimetype: 'audio/mpeg', ffmpeg: true, ...ex }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

async function main() {
    const av = process.argv.slice(2)
    if (!av.length || av[0] === '-h' || av[0] === '--help') help()
    const MODES = ['info', 'hd', 'sd', 'audio', 'mp3']
    const modeRaw = av[1] || 'info'
    if (!MODES.includes(modeRaw)) throw new Error(`mode "${modeRaw}" nggak dikenal. Pilihan: ${MODES.join(', ')}`)
    const MODE = modeRaw
    const inp = av[0]
    const rest = av.slice(2)
    const ex = await resolve(inp)
    if (MODE === 'info') {
        const t0 = Date.now()
        const resolutions = await Promise.all(ex.resolutions.map(async r => ({
            ...r,
            bytes: await _probeSize(r.url),
        })))
        for (const r of resolutions) r.size = r.bytes ? { bytes: r.bytes, mb: +(r.bytes / 1048576).toFixed(2) } : null
        console.log(JSON.stringify({
            status: 'success',
            ..._slim(ex),
            resolutions,
            watermark: ex.watermark, source: ex.source,
            timeSec: +((Date.now() - t0) / 1000).toFixed(2),
        }, null, 2))
        return
    }

    if (MODE === 'hd' || MODE === 'sd') {
        const want = MODE
        const r = ex.resolutions.find(x => x.quality === want)
        if (!r) throw new Error(`kualitas "${want}" nggak tersedia buat post ini. Yang ada: ${ex.resolutions.map(x => x.quality).join(', ') || 'nggak ada'}`)
        const out = rest.find(x => /\.(mp4|mp3)$/i.test(x)) || `${ex.id || 'fb'}-${want}.mp4`
        const t0 = Date.now()
        const bytes = await downloadFast(r.url, out)
        console.log(JSON.stringify({
            status: 'success',
            ..._slim(ex),
            mode: 'video', quality: want, tag: r.tag, cdn: r.url,
            resolution: r,
            bytes, size: { bytes, mb: +(bytes / 1048576).toFixed(2) },
            file: path.resolve(out), timeSec: +((Date.now() - t0) / 1000).toFixed(2),
        }, null, 2))
        return
    }

    const r = ex.resolutions[0]
    if (!r) throw new Error('post ini bukan video/reel, jadi nggak ada audio.')
    const out = rest[0] || (MODE === 'mp3' ? `${ex.id || 'fb'}.mp3` : `${ex.id || 'fb'}.m4a`)
    const t0 = Date.now()
    await downloadFast(r.url, out)
    if (!_hasFF) throw new Error('mode audio/mp3 butuh ffmpeg, dan ffmpeg nggak ada di sistem ini.')
    const tmp = out + '.src.mp4'
    fs.renameSync(out, tmp)
    const args = MODE === 'mp3'
        ? ['-y', '-v', 'error', '-i', tmp, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', out]
        : ['-y', '-v', 'error', '-i', tmp, '-vn', '-c:a', 'copy', out]
    const res = spawnSync('ffmpeg', args, { stdio: 'ignore' })
    fs.rmSync(tmp, { force: true })
    if (res.status !== 0) throw new Error('ffmpeg gagal ekstrak audio.')
    console.log(JSON.stringify({
        status: 'success',
        ..._slim(ex),
        mode: 'audio', ext: MODE === 'mp3' ? 'mp3' : 'm4a', ffmpeg: true,
        resolution: r,
        bytes: _size(out), size: { bytes: _size(out), mb: +(_size(out) / 1048576).toFixed(2) },
        file: path.resolve(out), timeSec: +((Date.now() - t0) / 1000).toFixed(2),
    }, null, 2))
}

const _slim = (ex) => {
    const { _emb, _meta, resolutions, ...rest } = ex
    return rest
}

//CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(e => { console.error(`Error: ${e.message}`); process.exit(1) })
}
