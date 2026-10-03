#!/usr/bin/env node
/*
Base    : https://www.tiktok.com
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Server-side fetch tiktok.com — tanpa browser, tanpa npm install
- Celah mobile-UA (iOS): desktop Chrome kena WAF Slardar, UA iPhone lolos
- Baca data SSR (api-data / __UNIVERSAL_DATA_FOR_REHYDRATION__) + retry anti varian-CSR
- Resolve semua format link: /video /photo /t, vt./vm.tiktok.com, id polos
- Video no-watermark (cookie tt_chain_token), audio, photo/carousel
- Slide: foto carousel dirangkai jadi 1 video MP4 (+ music post)
- Download paralel 8 chunk + retry + auto-refresh URL kalau expired
- Metadata lengkap: stats, author, music, hashtag, cover, dimensi
- Node >= 18; ffmpeg opsional buat convert audio ke mp3

Usage:
  node tikMw.mjs <url|id>            metadata JSON
  node tikMw.mjs <url|id> mp4        video (no-watermark)
  node tikMw.mjs <url|id> mp3        audio (m4a; mp3 kalau ada ffmpeg)
  node tikMw.mjs <url|id> photo      semua gambar carousel
  node tikMw.mjs <url|id> slide      foto carousel -> 1 video MP4 (butuh ffmpeg)
*/

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const _UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const _HDRS = {
    'user-agent': _UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
}
const _BIG = 8 * 1024 * 1024
const _CONC = 8
const _RETRY = 5
const _TTL = 5 * 60_000

const _jar = new Map()
const _cache = new Map()

//cookie sesi dari halaman TikTok (ttwid/tt_chain_token)
const _cookies = () => [..._jar].map(([k, v]) => `${k}=${v}`).join('; ')

// link -> id halaman
export async function resolveTarget(raw) {
    let s = String(raw || '').trim()
    if (!s) return null
    if (/^\d{15,20}$/.test(s)) return { id: s, url: null }
    if (!/^https?:\/\//i.test(s)) {
        if (/^((www|m|vt|vm|v)\.)?tiktok\.com(\/|$)/i.test(s)) s = 'https://' + s
        else return null
    }
    let u
    try { u = new URL(s) } catch { return null }
    const p = u.pathname.replace(/\/+$/, '')
    const m = p.match(/\/(?:video|photo)\/(\d{15,20})/)
    if (m) return { id: m[1], url: null }
    return { id: null, url: s }
}

function _absorb(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
        const kv = c.split(';')[0]
        const i = kv.indexOf('=')
        if (i > 0) _jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim())
    }
}

async function _fetch(url, timeout = 30000) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeout)
    try {
        const res = await fetch(url, { headers: _HDRS, redirect: 'follow', signal: ctrl.signal })
        _absorb(res)
        return res
    } finally { clearTimeout(t) }
}

function _parseItem(html) {
    const a = html.match(/<script[^>]*id="api-data"[^>]*>([\s\S]*?)<\/script>/)
    if (a) {
        try { const it = JSON.parse(a[1])?.videoDetail?.itemInfo?.itemStruct; if (it?.id) return it } catch { }
    }
    const b = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)
    if (b) {
        try {
            const ds = JSON.parse(b[1])?.__DEFAULT_SCOPE__ || {}
            for (const k of ['webapp.reflow.video.detail', 'webapp.video-detail']) {
                const it = ds[k]?.itemInfo?.itemStruct
                if (it?.id) return it
            }
        } catch { }
    }
    return null
}

async function _loadItem(id, candidates) {
    for (const url of candidates) {
        for (let i = 0; i < _RETRY; i++) {
            let res
            try { res = await _fetch(url) } catch { continue }
            const html = await res.text()
            if (/_wafchallengeid|SlardarWAF/.test(html)) continue
            const it = _parseItem(html)
            if (it) return it
        }
    }
    return null
}

const _cover = (v) => v?.cover || v?.originCover || v?.dynamicCover || ''

function _normalize(id, item) {
    const v = item.video || {}
    const images = (item.imagePost?.images || []).map(im => im?.imageURL?.urlList?.[0]).filter(Boolean)
    const isPhoto = images.length > 0 || (!!item.imagePost && !v.playAddr)
    const a = item.author || {}, mu = item.music || {}, st = item.stats || {}
    const kind = item.imagePost ? 'photo' : 'video'
    return {
        id,
        url: `https://www.tiktok.com/@${a.uniqueId || 'i'}/${kind}/${id}`,
        type: isPhoto ? (images.length > 1 ? 'carousel' : 'photo') : 'video',
        title: (item.desc || '').split('\n')[0].slice(0, 200),
        desc: item.desc || '',
        createTime: Number(item.createTime) || 0,
        createdAt: item.createTime ? new Date(Number(item.createTime) * 1000).toISOString() : null,
        duration: Number(v.duration) || 0,
        width: v.width || 0,
        height: v.height || 0,
        author: {
            id: a.id || '', uniqueId: a.uniqueId || '', nickname: a.nickname || '',
            signature: a.signature || '', verified: !!a.verified,
            avatar: a.avatarLarger || a.avatarMedium || a.avatarThumb || '',
            followerCount: a.followerCount || 0, followingCount: a.followingCount || 0,
            heartCount: a.heartCount || 0, videoCount: a.videoCount || 0,
        },
        music: { id: mu.id || '', title: mu.title || '', author: mu.authorName || '', duration: Number(mu.duration) || 0, url: mu.playUrl || '' },
        stats: {
            playCount: st.playCount || 0, likeCount: st.diggCount || 0, commentCount: st.commentCount || 0,
            shareCount: st.shareCount || 0, collectCount: st.collectCount || 0,
        },
        challenges: (item.challenges || []).map(c => ({ id: c.id, title: c.title, videoCount: c.stats?.videoCount || 0 })),
        thumbnail: _cover(v) || images[0] || '',
        covers: { cover: v.cover || '', originCover: v.originCover || '', dynamicCover: v.dynamicCover || '' },
        images,
        video: { playAddr: v.playAddr || '', downloadAddr: v.downloadAddr || '' },
    }
}

export async function extract(input, { fresh = false } = {}) {
    const tgt = await resolveTarget(input)
    if (!tgt) throw new Error('gak bisa baca link ini. Pakai link tiktok.com/{video|photo}/{id}, short link vt./vm., /t/, atau ID polos.')

    let id = tgt.id
    if (!id) {
        const res = await _fetch(tgt.url)
        id = String(res.url).match(/\/(?:video|photo)\/(\d{15,20})/)?.[1] || String(res.url).match(/(\d{15,20})/)?.[1]
        if (!id) throw new Error('gak bisa resolve ID dari link pendek ini.')
    }

    if (!fresh) {
        const c = _cache.get(id)
        if (c && Date.now() - c.at < _TTL) return c.data
    }

    const item = await _loadItem(id, [
        `https://www.tiktok.com/@i/video/${id}`,
        `https://www.tiktok.com/@i/photo/${id}`,
        tgt.url || `https://www.tiktok.com/@i/video/${id}`,
    ])
    if (!item) throw new Error('gak nemu data post (server balikin varian kosong terus). Coba lagi atau link lain.')

    const out = _normalize(id, item)
    _cache.set(id, { at: Date.now(), data: out })
    if (_cache.size > 120) _cache.delete(_cache.keys().next().value)
    return out
}

//download
async function _chunk(url, start, end, timeout = 30000) {
    const headers = { 'user-agent': _UA, referer: 'https://www.tiktok.com/', cookie: _cookies() }
    if (start != null) headers.range = `bytes=${start}-${end}`
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeout)
    try {
        const r = await fetch(url, { headers, signal: ctrl.signal })
        if (r.status !== 200 && r.status !== 206) return { status: r.status }
        const buf = Buffer.from(await r.arrayBuffer())
        const total = Number(String(r.headers.get('content-range') || '').split('/')[1]) || 0
        return { status: r.status, buf, total }
    } catch (e) { return { status: 0, err: e.message } } finally { clearTimeout(t) }
}

export async function downloadStream(urlIn, { refresh = null, timeout = 180000 } = {}) {
    const deadline = Date.now() + timeout
    let url = urlIn

    let first = await _chunk(url, 0, _BIG - 1)
    if (first.status === 403 && refresh) {
        const n = await refresh()
        if (n) { url = n; first = await _chunk(url, 0, _BIG - 1) }
    }
    if (first.status === 0) throw new Error('network error saat download: ' + (first.err || '?'))
    if (first.status === 403) throw new Error('URL CDN ditolak (403) — cookie/URL expired dan refresh gagal.')
    if (first.status === 200) return first.buf
    if (first.status !== 206) throw new Error('HTTP ' + first.status + ' saat download')
    if (!first.buf) throw new Error('chunk pertama kosong')
    const total = first.total
    if (!total) throw new Error('server gak ngasih total size (content-range kosong)')

    const parts = [{ start: 0, buf: first.buf }]
    const starts = []
    for (let s = first.buf.length; s < total; s += _BIG) starts.push(s)

    let idx = 0
    const results = new Array(starts.length)
    await Promise.all(Array.from({ length: Math.min(_CONC, starts.length) }, async () => {
        while (idx < starts.length) {
            const j = idx++
            const end = Math.min(total - 1, starts[j] + _BIG - 1)
            for (let attempt = 0; attempt < 3; attempt++) {
                if (Date.now() > deadline) throw new Error('download melewati batas waktu')
                const r = await _chunk(url, starts[j], end)
                if ((r.status === 200 || r.status === 206) && r.buf) { results[j] = r.buf; break }
                if (r.status === 403 && refresh) { const n = await refresh(); if (n) { url = n; continue } }
                await new Promise(res => setTimeout(res, 300))
            }
            if (!results[j]) throw new Error('chunk gagal @' + starts[j])
        }
    }))

    for (let i = 0; i < starts.length; i++) parts.push({ start: starts[i], buf: results[i] })
    parts.sort((a, b) => a.start - b.start)
    const out = Buffer.concat(parts.map(p => p.buf))
    if (out.length !== total) throw new Error(`ukuran gak cocok: ${out.length}/${total}`)
    return out
}

// refresh URL pas 403/expired — re-extract (playAddr yg lolos cookie)
const _refreshVideo = async (i) => (await extract(i, { fresh: true })).video.playAddr || null
const _refreshMusic = async (i) => (await extract(i, { fresh: true })).music.url || null
const _refreshImage = async (i, n) => (await extract(i, { fresh: true })).images[n] || null

const _hasFF = (() => { try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 } catch { return false } })()

function _toMp3(buf) {
    if (!_hasFF || !buf?.length) return null
    const base = path.join(os.tmpdir(), `tt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const inF = base + '.m4a', outF = base + '.mp3'
    try {
        fs.writeFileSync(inF, buf)
        const r = spawnSync('ffmpeg', ['-y', '-i', inF, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', outF], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 })
        if (r.status !== 0 || !fs.existsSync(outF)) return null
        const out = fs.readFileSync(outF)
        return out.length > 1000 ? out : null
    } catch { return null } finally { for (const f of [inF, outF]) { try { fs.unlinkSync(f) } catch { } } }
}

const _mime = (e) => ({ mp4: 'video/mp4', m4a: 'audio/mp4', mp3: 'audio/mpeg', jpg: 'image/jpeg', webp: 'image/webp' }[e] || 'application/octet-stream')

function _meta(ex, extra) {
    return {
        title: ex.title, author: ex.author.nickname, authorId: ex.author.uniqueId,
        url: ex.url, videoId: ex.id, desc: ex.desc, createTime: ex.createTime, createdAt: ex.createdAt,
        duration: ex.duration, stats: ex.stats, music: ex.music, challenges: ex.challenges,
        thumbnail: ex.thumbnail, engine: 'tiktok_web_ssr', type: ex.type, ...extra,
    }
}

export async function videoBuffer(input) {
    const ex = await extract(input)
    if (ex.type === 'photo' || ex.type === 'carousel') throw new Error(`post ini ${ex.type} (gambar), bukan video. Pakai mode photo.`)
    const urls = [ex.video.playAddr, ex.video.downloadAddr].filter(Boolean)
    if (!urls.length) throw new Error('URL video gak tersedia di halaman ini.')
    let buffer = null, lastErr = null
    for (const u of urls) { try { buffer = await downloadStream(u, { refresh: () => _refreshVideo(input) }); break } catch (e) { lastErr = e } }
    if (!buffer) throw lastErr || new Error('gagal download video')
    return {
        buffer, ..._meta(ex, {
            ext: 'mp4', mimetype: 'video/mp4', width: ex.width, height: ex.height,
            stream: { itag: 'tiktok_playaddr', container: 'mp4', codec: 'h264', width: ex.width, height: ex.height },
        }),
    }
}

export async function audioBuffer(input, { mp3 = true } = {}) {
    const ex = await extract(input)
    if (!ex.music.url) throw new Error('audio/music URL gak tersedia di halaman ini.')
    let buffer = await downloadStream(ex.music.url, { refresh: () => _refreshMusic(input) })
    let ext = 'm4a'
    if (mp3) { const c = _toMp3(buffer); if (c) { buffer = c; ext = 'mp3' } }
    return {
        buffer, ..._meta(ex, {
            ext, mimetype: _mime(ext),
            stream: { itag: 'tiktok_music', container: ext === 'mp3' ? 'mp3' : 'm4a', codec: ext === 'mp3' ? 'mp3' : 'aac' },
        }),
    }
}

export async function photoBuffers(input) {
    const ex = await extract(input)
    if (!ex.images.length) throw new Error('post ini gak punya gambar (bukan photo/carousel).')
    const items = []
    for (let i = 0; i < ex.images.length; i++) {
        const u = ex.images[i]
        const buffer = await downloadStream(u, { refresh: () => _refreshImage(input, i), timeout: 120000 })
        const ext = /\.webp(\?|$)/i.test(u) ? 'webp' : 'jpg'
        items.push({ index: i + 1, buffer, ext, mimetype: _mime(ext), url: u })
    }
    return { items, ..._meta(ex, { ext: items[0].ext, mimetype: items[0].mimetype, count: items.length }) }
}

// foto carousel -> 1 video MP4
function _slideshow(imgs, audio, perImg) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-slide-'))
    try {
        const files = []
        imgs.forEach((im, i) => {
            const p = path.join(dir, `img${String(i).padStart(3, '0')}.${im.ext}`)
            fs.writeFileSync(p, im.buffer)
            files.push(p)
        })
        const list = files.map(f => `file '${f}'\nduration ${perImg}`).join('\n') + `\nfile '${files[files.length - 1]}'\n`
        const listF = path.join(dir, 'list.txt')
        fs.writeFileSync(listF, list)
        const out = path.join(dir, 'out.mp4')
        const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listF]
        if (audio) {
            const af = path.join(dir, 'audio.m4a')
            fs.writeFileSync(af, audio)
            args.push('-i', af)
        }
        args.push('-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p',
            '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p')
        if (audio) args.push('-c:a', 'aac', '-shortest')
        args.push(out)
        const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 180000 })
        if (r.status !== 0 || !fs.existsSync(out)) throw new Error('ffmpeg gagal merangkai slide (exit ' + r.status + ')')
        return fs.readFileSync(out)
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { } }
}

export async function slideBuffer(input) {
    if (!_hasFF) throw new Error('mode slide butuh ffmpeg (belum ke-install). Pakai mode photo buat gambar mentahnya.')
    const ex = await extract(input)
    if (!ex.images.length) throw new Error('post ini gak punya gambar — slide cuma buat photo/carousel.')
    const imgs = []
    for (let i = 0; i < ex.images.length; i++) {
        const u = ex.images[i]
        const buffer = await downloadStream(u, { refresh: () => _refreshImage(input, i), timeout: 120000 })
        imgs.push({ buffer, ext: /\.webp(\?|$)/i.test(u) ? 'webp' : 'jpg' })
    }
    let audio = null
    if (ex.music.url) { try { audio = await downloadStream(ex.music.url, { refresh: () => _refreshMusic(input) }) } catch { } }
    const per = audio && ex.music.duration ? Math.max(1.5, Math.min(6, ex.music.duration / imgs.length)) : 3
    const buffer = _slideshow(imgs, audio, per)
    return {
        buffer, ..._meta(ex, {
            ext: 'mp4', mimetype: 'video/mp4', slides: imgs.length,
            slideDurationSec: +per.toFixed(2), withMusic: !!audio,
            stream: { itag: 'tiktok_slide', container: 'mp4', codec: 'h264', fps: 30 },
        }),
    }
}

//CLI
const _safe = (s) => String(s || 'tiktok').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'tiktok'

if (process.argv[1] && import.meta.url.endsWith('/' + path.basename(process.argv[1]))) {
    const [, , a1, a2, a3] = process.argv
    const target = a1
    const mode = a2 || 'info'
    const opt = a3

    if (!target) {
        console.log('pakai: node tikMw.mjs <url|id> [info|mp4|mp3|photo|slide] [output]')
        process.exit(1)
    }

    const emit = (r, extra) => {
        const { buffer, items, ...rest } = r
        if (items) rest.imagesMeta = items.map(it => ({ index: it.index, ext: it.ext, mimetype: it.mimetype, url: it.url }))
        console.log(JSON.stringify({ status: 'success', ...rest, ...extra }, null, 2))
    }

    try {
        if (mode === 'mp4') {
            const t0 = Date.now()
            const r = await videoBuffer(target)
            const f = opt || `${_safe(r.title)}_${r.duration || 0}s.mp4`
            fs.writeFileSync(f, r.buffer)
            emit(r, { size: { bytes: r.buffer.length, mb: +(r.buffer.length / 1048576).toFixed(2) }, file: f, timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else if (mode === 'slide') {
            const t0 = Date.now()
            const r = await slideBuffer(target)
            const f = opt || `${_safe(r.title)}_slide.mp4`
            fs.writeFileSync(f, r.buffer)
            emit(r, { size: { bytes: r.buffer.length, mb: +(r.buffer.length / 1048576).toFixed(2) }, file: f, timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else if (mode === 'mp3') {
            const t0 = Date.now()
            const r = await audioBuffer(target)
            const f = opt || `${_safe(r.title)}.${r.ext}`
            fs.writeFileSync(f, r.buffer)
            emit(r, { size: { bytes: r.buffer.length, mb: +(r.buffer.length / 1048576).toFixed(2) }, file: f, ffmpeg: _hasFF, timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else if (mode === 'photo') {
            const t0 = Date.now()
            const r = await photoBuffers(target)
            const files = []
            for (const it of r.items) {
                const f = r.items.length > 1 ? `${_safe(r.title)}_${it.index}.${it.ext}` : `${_safe(r.title)}.${it.ext}`
                fs.writeFileSync(f, it.buffer)
                files.push({ index: it.index, file: f, ext: it.ext, mimetype: it.mimetype, size: { bytes: it.buffer.length, mb: +(it.buffer.length / 1048576).toFixed(2) } })
            }
            emit(r, { files, totalBytes: files.reduce((a, b) => a + b.size.bytes, 0), timeSec: +((Date.now() - t0) / 1000).toFixed(2) })
        } else {
            console.log(JSON.stringify({ status: 'success', ...(await extract(target)) }, null, 2))
        }
    } catch (e) {
        console.error('GAGAL:', e.message)
        process.exit(1)
    }
}
