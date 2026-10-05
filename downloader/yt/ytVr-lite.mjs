#!/usr/bin/env node
/*
Base    : https://youtube.com
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Innertube no-PoToken (ANDROID_VR / IOS / VISIONOS fallback)
- Direct CDN stream: audio m4a/opus, video adaptive sampai 4K
- Range paralel anti-throttle (3MB < 1 detik)
- Auto-mux audio buat video >360p (ffmpeg -c copy)
- Playlist: daftar lagu + judul, channel, views, durasi, thumbnail, paging otomatis
- Community post: isi post (teks + gambar) dari halaman channel
- Zero dependency, Node >= 18

Usage:
  node ytVr-lite.mjs <url>            metadata JSON
  node ytVr-lite.mjs <url> mp3        audio
  node ytVr-lite.mjs <url> mp4 [res]  video (default 720p)
  node ytVr-lite.mjs <playlist-url|list-id> pl [limit]   daftar isi playlist
  node ytVr-lite.mjs <playlist-url|list-id> plmp3 [limit] [dir]  unduh audio semua
  node ytVr-lite.mjs <channel-community-url|post-id> post [limit]   post publik channel
*/

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const YT_EP = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'
const BROWSE_EP = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false'
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// browse (playlist & community post) cuma jalan di client WEB
const _BROWSE_CLIENT = { clientName: 'WEB', clientVersion: '2.20250312.04.00', hl: 'en', gl: 'US' }
const _BROWSE_HDR = {
    'content-type': 'application/json',
    'user-agent': UA_WEB,
    'x-youtube-client-name': '1',
    'x-youtube-client-version': _BROWSE_CLIENT.clientVersion,
    origin: 'https://www.youtube.com',
    referer: 'https://www.youtube.com/',
}

// client chain (UA native)
const _CLIENTS = [
    {
        name: 'android_vr', cn: '28',
        client: {
            clientName: 'ANDROID_VR', clientVersion: '1.56.21',
            deviceMake: 'Oculus', deviceModel: 'Quest 3',
            androidSdkVersion: 32, osName: 'Android', osVersion: '12L',
            hl: 'en', gl: 'US',
            userAgent: 'com.google.android.apps.youtube.vr.oculus/1.56.21 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        },
    },
    {
        name: 'ios', cn: '5',
        client: {
            clientName: 'IOS', clientVersion: '20.10.4',
            deviceMake: 'Apple', deviceModel: 'iPhone16,2',
            osName: 'iPhone', osVersion: '18.3.2.22D82',
            hl: 'en', gl: 'US',
            userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
        },
    },
    {
        name: 'visionos', cn: '101',
        client: {
            clientName: 'VISIONOS', clientVersion: '1.02',
            deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
            osName: 'visionOS', osVersion: '26.5.23O471',
            hl: 'en', gl: 'US',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
        },
    },
]

const ID_RE = /^[a-zA-Z0-9_-]{11}$/

export function resolveVideoId(raw) {
    let s = String(raw || '').trim()
    if (!s || s === 'youtube.com' || s === 'https://youtube.com' || s === 'https://www.youtube.com') return 'dQw4w9WgXcQ'
    if (ID_RE.test(s)) return s
    if (!/^https?:\/\//.test(s)) s = 'https://' + s
    let u
    try { u = new URL(s) } catch { return null }
    if (u.host === 'youtu.be') {
        const p = u.pathname.replace(/^\//, '')
        if (ID_RE.test(p)) return p
    }
    const v = u.searchParams.get('v')
    if (v && ID_RE.test(v)) return v
    const m = u.pathname.match(/^\/(?:embed|shorts|v|live|watch)\/([a-zA-Z0-9_-]{11})/)
    if (m) return m[1]
    return null
}

// innertube browse — dipakai playlist & community post
async function browse(body, { timeout = 25000 } = {}) {
    const r = await fetch(BROWSE_EP, {
        method: 'POST',
        headers: _BROWSE_HDR,
        body: JSON.stringify({ context: { client: _BROWSE_CLIENT }, ...body }),
        signal: AbortSignal.timeout(timeout),
    })
    const j = await r.json().catch(() => null)
    if (!j) throw new Error(`browse HTTP ${r.status} — respons bukan JSON (kemungkinan diblokir).`)
    if (j.error) throw new Error(`browse error ${j.error.code}: ${j.error.message || ''}`)
    return j
}

export function resolveListId(raw) {
    const s = String(raw || '').trim()
    if (!s) return null
    if (/^(PL|RD|UU|OLAK5uy_|LL)[A-Za-z0-9_-]{8,}$/.test(s)) return s
    const m = s.match(/[?&]list=([A-Za-z0-9_-]+)/)
    return m ? m[1] : null
}

// YouTube sudah pindah ke lockupViewModel untuk playlist; bentuk lama dipakai sebagai jaring pengaman
function _pickItems(j) {
    const c = j?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents
    if (Array.isArray(c)) return c
    const old = j?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
        ?.sectionListRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents
    return Array.isArray(old) ? old : []
}

function _nextContinuation(j) {
    const walk = (arr) => {
        for (const it of arr || []) {
            const t = it?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
            if (t) return t
        }
        return null
    }
    return walk(_pickItems(j))
        || walk(j?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems)
        || null
}

function _normLockup(it) {
    const l = it?.lockupViewModel
    if (!l?.contentId) return null
    const md = l.metadata?.lockupMetadataViewModel || {}
    const rows = md.metadata?.contentMetadataViewModel?.metadataRows || []
    const parts = rows.flatMap(r => r.metadataParts || []).map(p => p.text?.content).filter(Boolean)
    const ov = l.contentImage?.thumbnailViewModel?.overlays?.[0]?.thumbnailBottomOverlayViewModel?.badges || []
    const dur = (ov.find(b => /\d+:\d+/.test(b.thumbnailBadgeViewModel?.text || ''))?.thumbnailBadgeViewModel?.text) || ''
    const imgs = l.contentImage?.thumbnailViewModel?.image?.sources || []
    const views = (parts.find(p => /views?$/i.test(p)) || '').replace(/\s*views?$/i, '')
    return {
        videoId: l.contentId,
        title: md.title?.content || '',
        duration: dur,
        durationSeconds: dur ? dur.split(':').reduce((a, s) => a * 60 + Number(s), 0) : 0,
        author: parts[0] || '',
        views,
        viewsLabel: views ? `${views} views` : '',
        thumbnail: imgs.length ? imgs[imgs.length - 1].url : '',
        url: `https://youtu.be/${l.contentId}`,
    }
}

function _normOldPlaylistVideo(r) {
    return {
        videoId: r.videoId,
        title: r.title?.runs?.[0]?.text || '',
        duration: r.lengthText?.simpleText || '',
        durationSeconds: Number(r.lengthSeconds || 0),
        author: r.shortBylineText?.runs?.[0]?.text || '',
        views: (r.viewCountText?.simpleText || '').replace(/\s*views?$/i, ''),
        viewsLabel: r.viewCountText?.simpleText || '',
        thumbnail: (r.thumbnail?.thumbnails || []).slice(-1)[0]?.url || '',
        url: `https://youtu.be/${r.videoId}`,
    }
}

export async function playlist(input, { limit = 100, timeout = 25000 } = {}) {
    const listId = resolveListId(input)
    if (!listId) throw new Error('Playlist ID tidak terbaca. Contoh: https://www.youtube.com/playlist?list=PLxxxxxxxx atau PLxxxxxxxx langsung.')
    const j = await browse({ browseId: 'VL' + listId }, { timeout })

    const side = j?.sidebar?.playlistSidebarRenderer?.items?.[0]?.playlistSidebarPrimaryInfoRenderer
    const title = j?.header?.playlistHeaderRenderer?.title?.runs?.[0]?.text || side?.title?.runs?.[0]?.text || ''
    const countText = side?.stats?.[0]?.runs?.[0]?.text || ''
    const total = Number(String(countText).replace(/[^\d]/g, '')) || 0

    const out = []
    const seen = new Set()
    let page = j
    while (page && out.length < limit) {
        for (const it of _pickItems(page)) {
            const n = _normLockup(it) || (it?.playlistVideoRenderer ? _normOldPlaylistVideo(it.playlistVideoRenderer) : null)
            if (!n || !n.videoId || seen.has(n.videoId)) continue
            seen.add(n.videoId)
            out.push(n)
            if (out.length >= limit) break
        }
        const tok = _nextContinuation(page)
        if (!tok || out.length >= limit) break
        page = await browse({ continuation: tok }, { timeout })
    }
    if (!out.length) throw new Error('Playlist ini kosong, private, atau ID-nya salah.')
    return {
        status: 'success',
        listId, title, totalTracks: total || out.length,
        returned: out.length,
        hasMore: !!(total && out.length < total),
        url: `https://www.youtube.com/playlist?list=${listId}`,
        tracks: out,
    }
}

// community post: diambil dari HTML SSR halaman /@channel/community, tanpa login
export function resolvePostId(raw) {
    const s = String(raw || '').trim()
    if (!s) return null
    const m = s.match(/(Ugx[A-Za-z0-9_-]{10,})/)
    return m ? m[1] : null
}

export function resolveChannel(raw) {
    const s = String(raw || '').trim()
    if (!s) return null
    const m = s.match(/youtube\.com\/@([A-Za-z0-9_.-]{3,30})/) || s.match(/\/(?:c|channel|user)\/([A-Za-z0-9_.-]{3,30})/)
    return m ? m[1] : null
}

function _collectPosts(root, out = []) {
    if (!root || typeof root !== 'object') return out
    if (root.backstagePostRenderer) {
        const p = root.backstagePostRenderer
        if (p.postId) out.push(p)
    }
    for (const k of Object.keys(root)) {
        if (typeof root[k] === 'object') _collectPosts(root[k], out)
    }
    return out
}

function _normPost(p) {
    const runs = (r) => (r?.runs || []).map(x => x.text).join('')
    return {
        postId: p.postId,
        text: runs(p.contentText),
        author: runs(p.authorText),
        likes: p.voteCount?.simpleText || '',
        publishedAt: p.publishedTimeText?.simpleText || '',
        images: (p.backstageAttachment?.image?.sources || []).map(s => s.url),
        videoId: p.backstageAttachment?.video?.playableVideo?.videoId || '',
        url: `https://www.youtube.com/post/${p.postId}`,
    }
}

export async function post(input, { limit = 10, timeout = 30000 } = {}) {
    const ch = resolveChannel(input)
    const wantId = resolvePostId(input)
    // tanpa channel, cari tahu lewat ID post -> halamannya biasanya kena 404, jadi wajib ada channel
    if (!ch) throw new Error('Channel tidak terbaca. Pakai: node ytVr-lite.mjs https://www.youtube.com/@RickAstleyYT/community post')

    const url = `https://www.youtube.com/@${ch}/community`
    const r = await fetch(url, { headers: { 'user-agent': UA_WEB, 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(timeout) })
    const html = await r.text()
    if (r.status === 404) throw new Error(`Halaman community untuk @${ch} tidak ada (404).`)
    const m = html.match(/var ytInitialData\s*=\s*({.+?});<\/script>/)
    if (!m) throw new Error('ytInitialData tidak ketemu di halaman community — YouTube mungkin ganti layout, atau channel-nya private.')

    let data
    try { data = JSON.parse(m[1]) } catch { throw new Error('ytInitialData gagal di-parse (kemungkinan ada karakter aneh di teks post).') }

    const raw = _collectPosts(data)
    const seen = new Set()
    const posts = []
    for (const p of raw) {
        if (seen.has(p.postId)) continue
        seen.add(p.postId)
        posts.push(_normPost(p))
    }
    if (!posts.length) throw new Error(`Tidak ada post publik di @${ch}. Bisa channel-nya memang tidak pernah posting, atau semua post-nya private.`)

    const picked = wantId ? posts.filter(p => p.postId === wantId) : posts
    const out = (picked.length ? picked : posts).slice(0, Math.max(1, limit))
    return {
        status: 'success',
        channel: `@${ch}`,
        url,
        found: posts.length,
        returned: out.length,
        ...(wantId && picked.length ? {} : { note: wantId ? `Post ${wantId} tidak ada di halaman publik; menampilkan post terbaru.` : '' }),
        posts: out,
    }
}

// innertube player
export async function player(videoId, { timeout = 20000 } = {}) {
    let lastErr = null
    for (const c of _CLIENTS) {
        try {
            const r = await fetch(YT_EP, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'user-agent': c.client.userAgent,
                    'x-youtube-client-name': c.cn,
                    'x-youtube-client-version': c.client.clientVersion,
                    origin: 'https://www.youtube.com',
                    'x-origin': 'https://www.youtube.com',
                    referer: `https://www.youtube.com/watch?v=${videoId}`,
                },
                body: JSON.stringify({ videoId, context: { client: c.client }, contentCheckOk: true, racyCheckOk: true }),
                signal: AbortSignal.timeout(timeout),
            })
            const j = await r.json()
            const st = j?.playabilityStatus?.status
            const n = (j?.streamingData?.formats?.length || 0) + (j?.streamingData?.adaptiveFormats?.length || 0)
            if (st !== 'OK' || !n) {
                lastErr = new Error(`[${c.name}] playability ${st || '?'}${j?.playabilityStatus?.reason ? ' — ' + j.playabilityStatus.reason : ''}`)
                continue
            }
            j.__client = c.name
            return j
        } catch (e) { lastErr = new Error(`[${c.name}] ${e.message}`) }
    }
    throw lastErr || new Error('semua client gagal')
}

// metadata fallback via Web SSR (stream biasanya kosong, metadata selalu dapet)
async function webInfo(videoId) {
    const html = await (await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'user-agent': UA_WEB, 'accept-language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(20000),
    })).text()
    const m = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/)
    if (!m) throw new Error('web SSR: player response gak ketemu')
    return JSON.parse(m[1])
}

const _parseMime = (raw = '') => {
    const [container = '', codec = ''] = raw.split(';')
    return { container: container.trim(), codec: codec.replace('codecs=', '').trim().replace(/"/g, '') }
}

// extract cache 5 menit per videoId (cuma cache yang beneran punya stream)
const _cache = new Map()
const _TTL = 5 * 60_000

export async function extract(input, { fresh = false } = {}) {
    const videoId = resolveVideoId(input)
    if (!videoId) throw new Error('gak bisa resolve video ID')
    if (!fresh) {
        const c = _cache.get(videoId)
        if (c && Date.now() - c.at < _TTL) return c.data
    }
    let p, engine
    try { p = await player(videoId); engine = p.__client }
    catch { p = await webInfo(videoId); engine = 'web_ssr' }

    const d = p?.videoDetails || {}
    const audio = [], video = []
    for (const f of [...(p?.streamingData?.formats || []), ...(p?.streamingData?.adaptiveFormats || [])]) {
        if (!f.url) continue
        const { container, codec } = _parseMime(f.mimeType)
        const base = { itag: f.itag, mimeType: f.mimeType, container, codec, bitrate: f.bitrate || 0, contentLength: Number(f.contentLength || 0), url: f.url }
        if (container.startsWith('audio/')) audio.push({ ...base, audioQuality: f.audioQuality || '', audioQualityKbps: _fmtAud(f.audioQuality, f.bitrate) })
        else if (container.startsWith('video/')) video.push({ ...base, quality: f.qualityLabel || '', qualityLabel: _fmtVid(f.height, f.fps), width: f.width || 0, height: f.height || 0, fps: f.fps || 0, hasAudio: !!f.audioQuality || f.itag === 18 || f.itag === 22 })
    }
    audio.sort((a, b) => b.bitrate - a.bitrate)
    video.sort((a, b) => (b.height || 0) - (a.height || 0))
    const thumbs = d.thumbnail?.thumbnails || []
    const out = {
        videoId, engine,
        title: d.title || '', author: d.author || '',
        durationSeconds: Number(d.lengthSeconds || 0),
        viewCount: Number(d.viewCount || 0),
        isLive: !!d.isLiveContent,
        description: d.shortDescription || '',
        thumbnail: thumbs.length ? thumbs.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b)).url : `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        audio, video,
        totalStreams: audio.length + video.length,
    }
    if (out.totalStreams) { _cache.set(videoId, { at: Date.now(), data: out }); if (_cache.size > 120) _cache.delete(_cache.keys().next().value) }
    return out
}

export const pickAudio = (ex) => (ex.audio || []).find(s => s.itag === 140) || (ex.audio || []).find(s => s.container === 'audio/mp4') || (ex.audio || [])[0] || null

export function pickVideo(ex, targetHeight = 720) {
    const v = (ex.video || []).filter(s => s.url)
    if (!v.length) return null
    const under = v.filter(s => (s.height || 0) <= targetHeight)
    const pool = (under.length ? under : [v[v.length - 1]]).slice()
    pool.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.hasAudio ? 1 : 0) - (a.hasAudio ? 1 : 0))
    return pool[0] || null
}

async function streamUrl(input, itag) {
    const ex = await extract(input, { fresh: true })
    return [...ex.audio, ...ex.video].find(x => x.itag === itag)?.url || null
}

// downloader budget-aware
const _BIG = 4 * 1048576, _SMALL = 131072, _BUDGET = 1048576
export async function downloadStream(url, { totalSize = 0, refresh = null, timeout = 120000 } = {}) {
    const deadline = Date.now() + Math.max(20000, timeout)
    const left = () => deadline - Date.now()
    const g = async (u, start, end, ms) => {
        try {
            const r = await fetch(u, { headers: { 'user-agent': UA_WEB, range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(Math.max(5000, Math.min(ms, left()))) })
            const buf = r.status === 200 || r.status === 206 ? Buffer.from(await r.arrayBuffer()) : null
            const total = Number(String(r.headers.get('content-range') || '').split('/')[1]) || 0
            return { status: r.status, buf, total }
        } catch (e) { return { status: 0, buf: null, total: 0, err: e.message } }
    }
    const renew = async (cur) => {
        if (!refresh) throw new Error('budget habis & refresh gak tersedia')
        const u = await refresh()
        if (!u) throw new Error('refresh URL gagal')
        return u
    }

    let cur = url, total = Number(totalSize) || 0, pos = 0
    const parts = []
    while (true) {
        if (total && pos >= total) break
        const big = await g(cur, pos, pos + _BIG - 1, 25000)
        if (left() <= 0) throw new Error('deadline')

        if (big.status === 403) {
            // mode SMALL — jendela paralel 8×128KB, grind cap 30s, budget 1MB/URL
            const tGrind = Date.now()
            let served = 0
            while (!total || pos < total) {
                if (left() <= 0 || Date.now() - tGrind > 30000)
                    throw new Error('video ini bot-flagged: URL iOS dibatasi ~1MB/IP dan ada anti-throttle. Tanpa proxy, video seperti ini gak bisa diunduh utuh — coba video lain.')
                const want = Math.min(8 * _SMALL, total ? total - pos : 8 * _SMALL)
                const starts = Array.from({ length: Math.ceil(want / _SMALL) }, (_, i) => pos + i * _SMALL)
                const results = new Array(starts.length)
                let idx = 0
                await Promise.all(Array.from({ length: Math.min(8, starts.length) }, async () => {
                    while (idx < starts.length) {
                        const my = idx++
                        const end = Math.min((total ? total - 1 : starts[my] + _SMALL - 1), starts[my] + _SMALL - 1)
                        const r = await g(cur, starts[my], end, 10000)
                        if ((r.status === 200 || r.status === 206) && r.buf?.length) results[my] = r.buf
                    }
                }))
                const got = results.filter(Boolean)
                if (!got.length) { cur = await renew(cur); continue }
                for (let i = 0; i < starts.length; i++) {
                    if (!results[i]) break
                    parts.push({ start: starts[i], buf: results[i] })
                    pos += results[i].length
                }
                served += want
                if (served >= _BUDGET * 8 && refresh) { served = 0; cur = await renew(cur) }
            }
            continue
        }
        if (big.status === 0) throw new Error('network ' + (big.err || '?'))
        if (big.status !== 200 && big.status !== 206) throw new Error('http ' + big.status)
        if (big.status === 200) { parts.push({ start: pos, buf: big.buf }); break }
        if (!total) total = big.total
        if (!total) { parts.push({ start: pos, buf: big.buf }); break }
        parts.push({ start: pos, buf: big.buf })
        pos += big.buf.length

        const starts = []
        for (let s = pos; s < total; s += _BIG) starts.push(s)
        pos = total
        const results = new Array(starts.length)
        let idx = 0
        await Promise.all(Array.from({ length: Math.min(8, starts.length) }, async () => {
            while (idx < starts.length) {
                const my = idx++
                const end = Math.min(total - 1, starts[my] + _BIG - 1)
                for (let t = 0; t < 3; t++) {
                    const r = await g(cur, starts[my], end, 30000)
                    if ((r.status === 200 || r.status === 206) && r.buf?.length === end - starts[my] + 1) { results[my] = r.buf; break }
                    if (r.status === 403 && refresh) { cur = await renew(cur); continue }
                    await new Promise(res => setTimeout(res, 500))
                }
                if (!results[my]) throw new Error('chunk gagal @' + starts[my])
            }
        }))
        for (let i = 0; i < starts.length; i++) parts.push({ start: starts[i], buf: results[i] })
        break
    }
    parts.sort((a, b) => a.start - b.start)
    const out = Buffer.concat(parts.map(p => p.buf))
    if (total && out.length !== total) throw new Error(`size mismatch ${out.length}/${total}`)
    return out
}

const _dur = (s) => { s = Number(s || 0); const m = Math.floor(s / 60), d = Math.floor(s % 60); return `${m}:${String(d).padStart(2, '0')}` }

// embed metadata (title/artist/source) ke file — ffmpeg -c copy, gak re-encode.
// ffmpeg gak ada? skip aja, file tetep valid cuma tanpa tag.
const _hasFF = (() => { try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 } catch { return false } })()
function embedMeta(buf, { title = '', artist = '', comment = '', ext = 'm4a' }) {
    if (!_hasFF || !buf?.length) return buf
    const tmp = path.join(os.tmpdir(), `meta-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const inF = `${tmp}-in.${ext}`, outF = `${tmp}-out.${ext}`
    try {
        fs.writeFileSync(inF, buf)
        const r = spawnSync('ffmpeg', ['-y', '-i', inF, '-map', '0', '-c', 'copy',
            '-metadata', `title=${title}`, '-metadata', `artist=${artist}`,
            '-metadata', `comment=${comment}`, '-movflags', '+faststart', outF],
            { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 })
        if (r.status !== 0 || !fs.existsSync(outF)) return buf
        const out = fs.readFileSync(outF)
        return out.length > 1000 ? out : buf
    } catch { return buf } finally {
        for (const f of [inF, outF]) { try { fs.unlinkSync(f) } catch { } }
    }
}

// "AUDIO_QUALITY_MEDIUM" + bitrate 130677 -> "131kbps (medium)" — enum mentah YouTube
// gak enak dibaca, jadi diformat numerik; bitrate = sumber kebenaran utama.
function _fmtAud(audioQuality, bitrate) {
    const kbps = bitrate ? Math.round(bitrate / 1000) + 'kbps' : ''
    const map = { AUDIO_QUALITY_LOW: 'low', AUDIO_QUALITY_MEDIUM: 'medium', AUDIO_QUALITY_HIGH: 'high' }
    const q = map[audioQuality] || ''
    return kbps && q ? `${kbps} (${q})` : (kbps || q || 'unknown')
}

// height 720 + fps 30 -> "720p" ; 1080 + 60 -> "1080p60"
function _fmtVid(height, fps) {
    if (!height) return ''
    return fps >= 50 ? `${height}p${fps}` : `${height}p`
}

export async function audioBuffer(input, { timeout = 120000, meta = true } = {}) {
    const ex = await extract(input)
    const pick = pickAudio(ex)
    if (!pick?.url) throw new Error('stream audio gak tersedia')
    let buffer = await downloadStream(pick.url, { totalSize: pick.contentLength, refresh: () => streamUrl(input, pick.itag), timeout })
    const m4a = pick.container === 'audio/mp4'
    if (meta) buffer = embedMeta(buffer, { title: ex.title, artist: ex.author, comment: `https://youtu.be/${ex.videoId}`, ext: m4a ? 'm4a' : 'webm' })
    return {
        buffer, title: ex.title, author: ex.author, videoId: ex.videoId,
        description: ex.description, duration: _dur(ex.durationSeconds),
        durationSeconds: ex.durationSeconds, viewCount: ex.viewCount, isLive: ex.isLive,
        thumbnail: ex.thumbnail, engine: ex.engine,
        ext: m4a ? 'm4a' : 'webm', mimetype: m4a ? 'audio/mp4' : 'audio/webm',
        stream: { itag: pick.itag, container: pick.container, codec: pick.codec, bitrate: pick.bitrate, quality: pick.quality || _fmtVid(pick.height, pick.fps), audioQuality: pick.audioQuality || '', audioQualityKbps: pick.audioQualityKbps || _fmtAud(pick.audioQuality, pick.bitrate) },
    }
}

// mux video+audio (adaptive)
function mux(vBuf, aBuf, meta = {}) {
    return new Promise((resolve, reject) => {
        const tmp = path.join(os.tmpdir(), `ytvr-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        const vf = tmp + '.m4v', af = tmp + '.m4a', of = tmp + '.mp4'
        fs.writeFileSync(vf, vBuf); if (aBuf) fs.writeFileSync(af, aBuf)
        const tags = [
            '-metadata', `title=${meta.title || ''}`, '-metadata', `artist=${meta.artist || ''}`,
            '-metadata', `comment=${meta.comment || ''}`,
        ]
        const args = aBuf
            ? ['-y', '-i', vf, '-i', af, '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-shortest', ...tags, '-movflags', '+faststart', of]
            : ['-y', '-i', vf, '-c', 'copy', ...tags, '-movflags', '+faststart', of]
        const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
        let err = ''
        ff.stderr.on('data', d => { err = (err + d).slice(-4000) })
        ff.on('close', code => {
            if (code !== 0 || !fs.existsSync(of)) {
                for (const f of [vf, af, of]) { try { fs.unlinkSync(f) } catch { } }
                return reject(new Error('ffmpeg exit ' + code + ': ' + err.slice(-200)))
            }
            const buf = fs.readFileSync(of)
            for (const f of [vf, af, of]) { try { fs.unlinkSync(f) } catch { } }
            resolve(buf)
        })
        ff.on('error', e => reject(e))
    })
}

export async function videoBuffer(input, targetRes = 720, { timeout = 240000 } = {}) {
    const ex = await extract(input)
    const v = pickVideo(ex, targetRes)
    if (!v?.url) throw new Error('stream video gak tersedia')
    const meta = { title: ex.title, artist: ex.author, comment: `https://youtu.be/${ex.videoId}` }
    if (v.hasAudio) {
        let buffer = await downloadStream(v.url, { totalSize: v.contentLength, refresh: () => streamUrl(input, v.itag), timeout: timeout / 2 })
        buffer = embedMeta(buffer, { ...meta, ext: 'mp4' })
        return {
            buffer, title: ex.title, author: ex.author, videoId: ex.videoId,
            description: ex.description, duration: _dur(ex.durationSeconds),
            durationSeconds: ex.durationSeconds, viewCount: ex.viewCount, isLive: ex.isLive,
            thumbnail: ex.thumbnail, engine: ex.engine,
            height: v.height, ext: 'mp4', mimetype: 'video/mp4',
            stream: { itag: v.itag, container: v.container, codec: v.codec, fps: v.fps },
        }
    }
    const a = (ex.audio || []).find(s => s.container === 'audio/mp4') || pickAudio(ex)
    const [vBuf, aBuf] = await Promise.all([
        downloadStream(v.url, { totalSize: v.contentLength, refresh: () => streamUrl(input, v.itag), timeout: timeout / 2 }),
        a ? downloadStream(a.url, { totalSize: a.contentLength, refresh: () => streamUrl(input, a.itag), timeout: timeout / 2 }) : Promise.resolve(null),
    ])
    return {
        buffer: await mux(vBuf, aBuf, meta), title: ex.title, author: ex.author, videoId: ex.videoId,
        description: ex.description, duration: _dur(ex.durationSeconds),
        durationSeconds: ex.durationSeconds, viewCount: ex.viewCount, isLive: ex.isLive,
        thumbnail: ex.thumbnail, engine: ex.engine,
        height: v.height, ext: 'mp4', mimetype: 'video/mp4',
        stream: { itag: v.itag, container: v.container, codec: v.codec, fps: v.fps, audioItag: a?.itag || null },
    }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const [, , target, mode = 'info', opt] = process.argv
    if (!target) {
        console.log('pakai: node ytVr-lite.mjs <url|videoId> [info|mp3|mp4] [opt]')
        console.log('       node ytVr-lite.mjs <playlist> [pl|plmp3] [limit] [dir]')
        console.log('       node ytVr-lite.mjs <post-url> post')
        process.exit(1)
    }
    // dump hasil (minus buffer) sebagai JSON lengkap — metadata, desc, stream, dll
    const _dump = (r, f, dt) => console.log(JSON.stringify({
        status: 'success',
        title: r.title, author: r.author,
        videoId: r.videoId, url: `https://youtu.be/${r.videoId}`,
        duration: r.duration, durationSeconds: r.durationSeconds,
        viewCount: r.viewCount, isLive: r.isLive,
        description: r.description,
        thumbnail: r.thumbnail, engine: r.engine,
        stream: r.stream,
        file: f, ext: r.ext, mimetype: r.mimetype,
        size: { bytes: r.buffer.length, mb: +(r.buffer.length / 1048576).toFixed(2) },
        metadataEmbedded: true, timeSec: +dt,
    }, null, 2))

    if (mode === 'mp3') {
        const t0 = Date.now()
        try {
            const r = await audioBuffer(target)
            const f = opt || `${r.title.replace(/[<>:"/\\|?*]/g, '_')}.${r.ext}`
            fs.writeFileSync(f, r.buffer)
            _dump(r, f, (Date.now() - t0) / 1000)
        } catch (e) {
            console.error('GAGAL:', e.message)
            process.exit(1)
        }
    } else if (mode === 'mp4') {
        const t0 = Date.now()
        try {
            const r = await videoBuffer(target, Number(opt) || 720)
            const f = `${r.title.replace(/[<>:"/\\|?*]/g, '_')}_${r.height}p.mp4`
            fs.writeFileSync(f, r.buffer)
            _dump(r, f, (Date.now() - t0) / 1000)
        } catch (e) {
            console.error('GAGAL:', e.message)
            process.exit(1)
        }
    } else if (mode === 'pl') {
        try {
            const r = await playlist(target, { limit: Math.min(Number(opt) || 100, 500) })
            console.log(JSON.stringify(r, null, 2))
        } catch (e) {
            console.error('GAGAL:', e.message)
            process.exit(1)
        }
    } else if (mode === 'plmp3') {
        const limit = Math.min(Number(opt) || 20, 500)
        const dir = process.argv[5] || 'playlist'
        const t0 = Date.now()
        try {
            const r = await playlist(target, { limit })
            fs.mkdirSync(dir, { recursive: true })
            const done = []
            const failed = []
            for (const [i, t] of r.tracks.entries()) {
                try {
                    const a = await audioBuffer(t.videoId)
                    const f = path.join(dir, `${String(i + 1).padStart(3, '0')}_${a.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 70)}.${a.ext}`)
                    fs.writeFileSync(f, a.buffer)
                    done.push({ index: i + 1, file: f, size: a.buffer.length, durationSeconds: t.durationSeconds })
                } catch (e) {
                    failed.push({ index: i + 1, videoId: t.videoId, title: t.title, error: e.message })
                }
            }
            console.log(JSON.stringify({
                status: 'success',
                playlist: r.title, listId: r.listId, url: r.url,
                requested: r.returned, downloaded: done.length, failed: failed.length,
                dir, files: done, errors: failed,
                timeSec: +((Date.now() - t0) / 1000).toFixed(2),
            }, null, 2))
        } catch (e) {
            console.error('GAGAL:', e.message)
            process.exit(1)
        }
    } else if (mode === 'post') {
        try {
            console.log(JSON.stringify(await post(target, { limit: Math.min(Number(opt) || 10, 50) }), null, 2))
        } catch (e) {
            console.error('GAGAL:', e.message)
            process.exit(1)
        }
    } else {
        console.log(JSON.stringify(await extract(target), null, 2))
    }
}
