#!/usr/bin/env node
/*
Base    : https://soundcloud.com (api-v2.soundcloud.com)
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Resolve URL apa pun (track / user / playlist) -> metadata penuh, JSON-only
- Track: judul, author, durasi, deskripsi, genre, tags, artwork multi-ukuran,
  waveform, play/like/comment/download/repost count, license, tanggal,
  publisher metadata, daftar format stream (preset/protocol/mime/quality)
- Playlist/album: semua track di-hydrate via /tracks?ids= (batch 50) supaya
  stub {id,kind} dari resolve jadi metadata penuh, urut + posisi track
- Download audio (mode mp3): HLS fMP4 -> init + segmen -> concat -> remux ffmpeg
  (aac_96k -> .m4a, abr_sq opus -> .opus), embed metadata, tanpa dependency
- Search (all/tracks/users/playlists/albums), user (profil + track, paging),
  likes, toptracks, followers, following, pl (isi playlist), related
- Comments track (query threaded=0), playlists yang memuat sebuah track
- Charts trending, recent tracks per tag, suggest (query + tag autocomplete)
- Anti-block (tanpa proxy, koneksi langsung — nol SOCKS/HTTP proxy):
  * pacing strict: jeda >= SC_GAP ms antar request API + jitter acak,
    concurrency dibatasi (SC_CONC), jadi request padat tetep "santai"
  * retry exponential backoff + jitter; 429/403/5xx/network auto dicoba lagi
  * Happy Eyeballs staggered: kalo satu edge IP CloudFront di-blackhole,
    request otomatis pindah IP (Jitter 250ms) — gak nge-lag 20 detik
  * keep-alive agent (TLS session dipakai ulang), IPv4-only (no IPv6 stall)
  * cookie session sc_anonymous_id (kayak satu browser sesion)
  * single-flight: request identik paralel digabung, bukan diulang
  * cache disk resolve/API + client_id (TTL, SC_CACHE=0 untuk matiin)
  * client_id di-refresh dari 3 sumber paralel kalo 401
- Nol proxy, nol dependency, Node >= 18

Usage:
  node sndCl.mjs <url> [info]                  metadata penuh (auto track/user/playlist)
  node sndCl.mjs <url> mp3 [file] [sq|aac]     unduh audio (default aac; sq butuh login, auto-fallback)
  node sndCl.mjs search "<q>" [limit] [scope]  scope: all|tracks|users|playlists|albums
  node sndCl.mjs suggest "<q>" [limit]         autocomplete query + tag
  node sndCl.mjs <user-url> user [limit]       profil + track user
  node sndCl.mjs <user-url> likes [limit]      track/playlist yang di-like user
  node sndCl.mjs <user-url> toptracks [limit]  top track user
  node sndCl.mjs <user-url> followers [limit]  follower user
  node sndCl.mjs <user-url> following [limit]  following user
  node sndCl.mjs <pl-url> pl [limit]           isi playlist/album (hydrate penuh)
  node sndCl.mjs <track-url> related [limit]   track serupa
  node sndCl.mjs <track-url> comments [limit]  komentar track
  node sndCl.mjs <track-url> playlists [limit] playlist yang memuat track
  node sndCl.mjs tag "<tag>" [limit]           recent tracks per tag
  node sndCl.mjs charts [genre] [limit]        trending charts (default all-music)
*/

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import zlib from 'node:zlib'
import dns from 'node:dns'
import { spawnSync } from 'node:child_process'

// ---------- STANDAR ERROR BAHASA MESIN ----------
// Isi field `error` SELALU pesan dari daftar ini, bukan pesan mentah
// server/kode. Detail asli (URL, status HTTP, pesan server) disimpan di
// field `detail` terpisah. Lihat docs/ERROR-KIND.md
const KIND_MSG = {
    bad_input: 'invalid usage expected home | section <type> [page] | search "<kw>" | <url> [info|streams]',
    not_found: 'not found check slug url keyword may be removed or parser changed',
    ip_blocked: 'ip blocked or rate limited retry later or switch base mirror',
    service_down: 'origin down 52x target unreachable retry later',
    network: 'network error check connection dns reset',
    parse_changed: 'parser changed site structure updated',
    redirect: 'redirect detected open redirect field',
    unknown: 'unknown error check message',
}

const mkFail = (kind, detail) => {
    const e = new Error(KIND_MSG[kind] || KIND_MSG.unknown)
    e.kind = kind
    if (detail) e.detail = String(detail).slice(0, 200)
    return e
}

const kindOf = (e) => {
    if (e && e.kind && KIND_MSG[e.kind]) return e.kind
    const m = String((e && (e.message + ' ' + (e.detail || ''))) || '').toLowerCase()
    if (/\b(403|429|forbidden|rate limit|too many requests|captcha|blocked)\b/.test(m)) return 'ip_blocked'
    if (/\b(400|bad request|invalid usage|unknown command)\b/.test(m)) return 'bad_input'
    if (/\b(404|not found|no results|tidak ditemukan)\b/.test(m)) return 'not_found'
    if (/\b(52[0-9]|503|service unavailable|bad gateway|gateway timeout)\b/.test(m)) return 'service_down'
    if (/\b(redirect|moved permanently|moved temporarily|301|302|307|308)\b/.test(m)) return 'redirect'
    if (/\b(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed|timeout)\b/.test(m)) return 'network'
    if (/\b(json|parse|unexpected token|structure|selector)\b/.test(m)) return 'parse_changed'
    return 'unknown'
}

const failOut = (e, extra = {}) => {
    const kind = kindOf(e)
    console.log(JSON.stringify({
        status: 'error',
        kind,
        error: KIND_MSG[kind] || KIND_MSG.unknown,
        ...(e && e.detail ? { detail: String(e.detail).slice(0, 200) } : {}),
        ...extra,
    }, null, 2))
    process.exit(1)
}


const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const API = 'https://api-v2.soundcloud.com'
const WATERMARK = 'VenzioLûx — Vloûte Cataclysm'

let CID = 'QhVEWrrJKvW4uSU5u5EoI0FTXYUGzy5k'
const REQ_TIMEOUT = 20000
const MIN_GAP = 350
const MAX_CONC = 3
const MAX_RETRY = 4
const CACHE_TTL = 600 * 1000
const CACHE_DIR = path.join(os.tmpdir(), 'sndcl-cache')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const jitter = (base, spread) => base + Math.floor(Math.random() * spread)

function delay(ms, signal) {
    return new Promise(res => {
        if (signal && signal.aborted) return res()
        let t = null
        const onAbort = () => { if (t) clearTimeout(t); res() }
        t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); res() }, ms)
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
    })
}

const JAR = new Map()
function jarApplyOne(raw) {
    if (!raw) return
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    if (i < 1) return
    const name = pair.slice(0, i).trim(), val = pair.slice(i + 1).trim()
    if (!val || /=$/.test(val)) { JAR.delete(name); return }
    JAR.set(name, val)
}
function jarHeader(host) {
    if (!JAR.size) return null
    const out = []
    for (const [k, v] of JAR) {
        if (k === 'sc_anonymous_id' || host.endsWith('soundcloud.com')) out.push(k + '=' + v)
    }
    return out.length ? out.join('; ') : null
}

function cachePath(key) {
    const h = crypto.createHash('sha1').update(key).digest('hex')
    return path.join(CACHE_DIR, h.slice(0, 2), h + '.json')
}
function cacheGet(key) {
    try {
        const f = cachePath(key)
        const st = fs.statSync(f)
        if (Date.now() - st.mtimeMs > CACHE_TTL) { fs.unlinkSync(f); return null }
        return JSON.parse(fs.readFileSync(f, 'utf8'))
    } catch { return null }
}
function cacheSet(key, val) {
    try {
        const f = cachePath(key)
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, JSON.stringify(val))
    } catch {}
}

function makeScheduler(conc, gap, jitterMax = 90) {
    let lastStart = 0, active = 0
    let chain = Promise.resolve()
    const queue = []
    function pump() {
        while (active < conc && queue.length) {
            const job = queue.shift()
            active++
            Promise.resolve()
                .then(job)
                .catch(() => {})
                .finally(() => { active--; pump() })
        }
    }
    function gate() {
        if (!gap) return Promise.resolve()
        const run = chain.then(async () => {
            const wait = lastStart + gap - Date.now()
            if (wait > 0) await sleep(wait + (jitterMax ? jitter(0, jitterMax) : 0))
            lastStart = Date.now()
        })
        chain = run.catch(() => {})
        return run
    }
    function schedule(fn) {
        return new Promise((res, rej) => {
            queue.push(() => { Promise.resolve().then(fn).then(res, rej) })
            pump()
        })
    }
    return { gate, schedule }
}

const API_SCHED = makeScheduler(MAX_CONC, MIN_GAP)
const CDN_SCHED = makeScheduler(8, 0, 0)

// single-flight
const inflight = new Map()
function once(key, fn) {
    if (inflight.has(key)) return inflight.get(key)
    const p = fn().finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
}

const CONNECT_TIMEOUT = 5000
const AGENT = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: 16,
    maxFreeSockets: 8,
    timeout: 30000,
    // Happy Eyeballs: coba IPv4 dulu, baru IPv6
    family: 4,
})
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 8, family: 4 })

const IP_ROTATE = new Map()
function primeIps(host, ips) {
    if (!ips || !ips.length) return
    const cur = IP_ROTATE.get(host) || []
    const merged = [...cur, ...ips.filter(x => !cur.includes(x))]
    IP_ROTATE.set(host, merged)
}

const IP_CURSOR = new Map()
function nextIpRr(host, ips) {
    if (!ips || !ips.length) return null
    const cur = IP_CURSOR.get(host) || 0
    IP_CURSOR.set(host, (cur + 1) % ips.length)
    return ips[cur % ips.length]
}

const DNS_CACHE = new Map()
const DNS_TTL = 60000
async function resolve4(host) {
    const hit = DNS_CACHE.get(host)
    if (hit && Date.now() - hit.at < DNS_TTL) return hit.ips
    let t = null
    try {
        const ips = await Promise.race([
            dns.promises.resolve4(host),
            new Promise(res => { t = setTimeout(() => res([]), 2000) }),
        ])
        if (ips.length) DNS_CACHE.set(host, { ips, at: Date.now() })
        return ips
    } catch { return [] }
    finally { if (t) clearTimeout(t) }
}

function reqOnce(url, { timeout, headers, method = 'GET', lookup = null, signal = null, onConnect = null }) {
    return new Promise((resolve, reject) => {
        const u = new URL(url)
        const mod = u.protocol === 'http:' ? http : https
        const agent = u.protocol === 'http:' ? HTTP_AGENT : AGENT
        let connectTimer = null, readTimer = null, done = false
        const cleanup = () => { if (connectTimer) { clearTimeout(connectTimer); connectTimer = null } if (readTimer) { clearTimeout(readTimer); readTimer = null } }
        const reqOpts = {
            method,
            agent,
            family: 4,
            headers,
            rejectUnauthorized: true,
            servername: u.hostname,
        }
        if (lookup) reqOpts.lookup = lookup
        if (signal) reqOpts.signal = signal
        const req = mod.request(url, reqOpts, res => {
            if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
            readTimer = setTimeout(() => req.destroy(mkFail('network', 'read timeout')), timeout)
            const chunks = []
            res.on('data', c => chunks.push(c))
            res.on('end', () => {
                cleanup()
                const raw = Buffer.concat(chunks)
                const enc = String(res.headers['content-encoding'] || '').toLowerCase()
                let body = raw
                try {
                    if (enc === 'gzip') body = zlib.gunzipSync(raw)
                    else if (enc === 'deflate') body = zlib.inflateSync(raw)
                    else if (enc === 'br') body = zlib.brotliDecompressSync(raw)
                } catch { body = raw }
                resolve({ status: res.statusCode, headers: res.headers, body })
            })
            res.on('error', e => { cleanup(); reject(e) })
        })
        req.on('socket', s => {
            if (s.connecting) {
                connectTimer = setTimeout(() => req.destroy(mkFail('network', 'connect timeout')), CONNECT_TIMEOUT)
                s.once('connect', () => {
                    if (connectTimer && !s.encrypted) { clearTimeout(connectTimer); connectTimer = null }
                    if (onConnect) onConnect()
                })
                s.once('secureConnect', () => {
                    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
                    if (onConnect) onConnect()
                })
            } else {
                if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
                if (onConnect) onConnect()
            }
        })
        req.on('error', e => {
            cleanup()
            if (done) return
            done = true
            if (!e.kind) e.kind = e.name === 'AbortError' ? 'aborted' : 'network'
            reject(e)
        })
        req.end()
    })
}

async function httpGet(url, { timeout = REQ_TIMEOUT, headers = {}, cookies = true, binary = false, strategy = 'api' } = {}) {
    const u = new URL(url)
    const h = {
        'user-agent': UA,
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate',
        ...headers,
    }
    if (cookies) {
        const c = jarHeader(u.hostname)
        if (c) h.cookie = c
    }
    const finish = r => {
        const setCookies = r.headers['set-cookie']
        if (setCookies) for (const c of [].concat(setCookies)) jarApplyOne(c)
        return { status: r.status, headers: r.headers, body: binary ? r.body : r.body.toString('utf8'), bytes: r.body.length }
    }
    const ips = await resolve4(u.hostname)
    primeIps(u.hostname, ips)
    if (strategy === 'cdn') {
        const start = nextIpRr(u.hostname, ips)
        const order = start ? [start, ...ips.filter(x => x !== start)] : ips
        let lastErr = null
        for (const ip of order.slice(0, 3)) {
            try {
                const r = await reqOnce(url, {
                    timeout,
                    headers: h,
                    lookup: (host, o, cb) => cb(null, ip, 4),
                })
                return finish(r)
            } catch (e) {
                lastErr = e
                if (e.kind !== 'connect' && e.kind !== 'network') throw e
            }
        }
        if (!lastErr) {
            const r = await reqOnce(url, { timeout, headers: h })
            return finish(r)
        }
        throw lastErr
    }
    const candidates = ips.slice(0, 4)
    const ctl = new AbortController()
    if (!candidates.length) {
        return finish(await reqOnce(url, { timeout, headers: h }))
    }
    let winner = null, lastErr = null, pending = 0
    let resolveDone
    const done = new Promise(res => { resolveDone = res })

    const launch = ip => {
        const ac = new AbortController()
        ctl.signal.addEventListener('abort', () => ac.abort(), { once: true })
        pending++
        let connected = false
        const p = reqOnce(url, {
            timeout,
            headers: h,
            signal: ac.signal,
            lookup: (host, o, cb) => cb(null, ip, 4),
            onConnect: () => { connected = true },
        }).then(r => {
            if (!winner) { winner = r; resolveDone() }
        }).catch(e => {
            if (!lastErr) lastErr = e
        }).finally(() => {
            pending--
            if (pending === 0 && !winner) resolveDone()
        })
        return { p, connected: () => connected }
    }

    const attempts = []
    let cur = launch(candidates[0])
    attempts.push(cur)
    for (let i = 1; i < candidates.length; i++) {
        const ok = await Promise.race([
            delay(250, ctl.signal).then(() => 'timeout'),
            cur.p.then(() => 'done'),
        ])
        if (winner) break
        if (ok === 'done' || cur.connected()) break
        cur = launch(candidates[i])
        attempts.push(cur)
    }
    await done
    ctl.abort()
    if (!winner) throw lastErr || new Error('gagal connect: ' + url)
    return finish(winner)
}

const NO_RETRY = new Set(['fatal', 'not_found', 'cid', 'bad_input'])
const SLOW_BACKOFF = { geo_blocked: 6000, rate_limited: 5000, server: 1200 }
const FAST_BACKOFF = { connect: 120, network: 200, timeout: 150, segment: 100 }

async function retrying(label, fn, { tries = MAX_RETRY } = {}) {
    let lastErr = null
    for (let i = 0; i < tries; i++) {
        try {
            return await fn(i)
        } catch (e) {
            lastErr = e
            if (NO_RETRY.has(e.kind) || e.kind === 'fatal') throw e
            const fast = FAST_BACKOFF[e.kind]
            const base = fast || SLOW_BACKOFF[e.kind] || 800
            const wait = fast ? fast + jitter(0, 150) : Math.min(30000, base * Math.pow(2, i)) + jitter(0, 400)
            await sleep(wait)
        }
    }
    throw lastErr || new Error('gagal: ' + label)
}

const CID_SOURCES = [
    { url: 'https://soundcloud.com/', re: /hydratable":"apiClient","data":\{"id":"([A-Za-z0-9]{28,40})"/ },
    { url: 'https://m.soundcloud.com/', re: /"clientId":"([A-Za-z0-9]{28,40})"/ },
    { url: 'https://soundcloud.com/', re: /"client_id":\s*"([A-Za-z0-9]{28,40})"/ },
]
function cidCachePath() { return path.join(CACHE_DIR, 'client_id.json') }
function cidCacheGet() {
    try {
        const j = JSON.parse(fs.readFileSync(cidCachePath(), 'utf8'))
        if (j && j.cid) return j.cid
    } catch {}
    return null
}
function cidCacheSet(cid) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true })
        fs.writeFileSync(cidCachePath(), JSON.stringify({ cid, at: Date.now() }))
    } catch {}
}

export async function refreshCid() {
    const ctl = new AbortController()
    const attempts = CID_SOURCES.map((src, i) => {
        const ac = new AbortController()
        ctl.signal.addEventListener('abort', () => ac.abort(), { once: true })
        return (i === 0 ? Promise.resolve() : delay(400 * i, ac.signal)).then(() => {
            if (ac.signal.aborted) throw mkFail('unknown', 'aborted')
            return httpGet(src.url, { timeout: 8000, cookies: true }).then(r => {
                if (r.status !== 200) throw mkFail('unknown', 'http ' + r.status)
                const m = String(r.body).match(src.re)
                if (!m) throw mkFail('parse_changed', 'cid not found in ' + src.url)
                return m[1]
            })
        })
    })
    let cid
    try {
        cid = await Promise.any(attempts)
    } finally {
        ctl.abort()
    }
    CID = cid
    cidCacheSet(cid)
    return CID
}

function apiUrl(ep, params = {}) {
    const qs = new URLSearchParams({ client_id: CID, ...params })
    return API + ep + '?' + qs
}

function cacheKey(ep, params = {}) {
    return ep + '?' + new URLSearchParams(params).toString()
}

async function apiGetRaw(ep, params = {}) {
    const key = cacheKey(ep, params)
    const hit = cacheGet(key)
    if (hit) return hit
    return once(key, async () => {
        const url = apiUrl(ep, params)
        const r = await retrying(ep, async () => {
            const res = await API_SCHED.schedule(() => API_SCHED.gate().then(() => httpGet(url)))
            if (res.status === 401) throw mkFail('ip_blocked', 'client_id invalid')
            if (res.status === 403) throw mkFail('ip_blocked', 'cloudfront blocked this ip')
            if (res.status === 404) throw mkFail('not_found', 'resolve http 404')
            if (res.status === 429) throw mkFail('ip_blocked', 'rate limited')
            if (res.status >= 500) throw mkFail('service_down', 'http ' + res.status)
            if (res.status !== 200) throw mkFail('unknown', 'http ' + res.status)
            return res
        })
        let json
        try { json = JSON.parse(r.body) } catch { throw mkFail('parse_changed', 'response not json') }
        cacheSet(key, json)
        return json
    })
}

async function apiGet(ep, params = {}) {
    try {
        return await apiGetRaw(ep, params)
    } catch (e) {
        if (e.kind === 'cid') {
            try { await refreshCid() } catch {
                const cached = cidCacheGet()
                if (cached && cached !== CID) { CID = cached; return apiGetRaw(ep, params) }
                throw e
            }
            return apiGetRaw(ep, params)
        }
        throw e
    }
}

export async function resolve(url) { return apiGet('/resolve', { url }) }

function nextUrl(href) {
    if (!href) return null
    if (/([?&])client_id=/.test(href)) return href.replace(/([?&])client_id=[^&]+/, '$1client_id=' + CID)
    return href + (href.includes('?') ? '&' : '?') + 'client_id=' + CID
}

async function pageAll(first, map, limit) {
    const out = (first.collection || []).map(map).filter(x => x != null)
    let d = first
    while (d.next_href && out.length < limit) {
        const url = nextUrl(d.next_href)
        const hit = cacheGet(url)
        let nd = hit
        if (!nd) {
            const r = await once(url, () => retrying('page', async () => {
                const res = await API_SCHED.schedule(() => API_SCHED.gate().then(() => httpGet(url)))
                if (res.status === 404) throw mkFail('not_found', 'page http 404')
                if (res.status !== 200) throw mkFail('unknown', 'page http ' + res.status)
                return res
            })).catch(e => { if (e.kind === 'fatal') throw e; return null })
            if (!r) break
            try { nd = JSON.parse(r.body) } catch { break }
            cacheSet(url, nd)
        }
        d = nd
        out.push(...(d.collection || []).map(map).filter(x => x != null))
    }
    return out.slice(0, limit)
}

const dur = ms => { const s = Math.round((ms || 0) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }
const WM = WATERMARK

function _visArt(t) {
    const v = t?.visuals
    if (!v) return ''
    const srcs = v.visuals?.items || v.items || []
    for (const it of srcs) {
        const url = it?.visual?.url || it?.url
        if (url) return url
    }
    return ''
}

function artAll(u, fallback = '') {
    if (!u) u = fallback || ''
    if (!u) return { t67: '', large: '', t500: '', crop: '', original: '' }
    const base = u.replace(/-(large|t500x500|badge|original|crop|tiny|mini|t67x67|t120x120)\.jpg/, '')
    return { t67: base + '-t67x67.jpg', large: base + '-large.jpg', t500: base + '-t500x500.jpg', crop: base + '-crop.jpg', original: base + '-original.jpg' }
}

function author(u) {
    if (!u) return { id: 0, username: '', url: '', followers: 0, verified: false, avatar: '' }
    return { id: u.id, username: u.username || '', url: u.permalink_url || '', followers: u.followers_count ?? 0, verified: !!u.verified, avatar: u.avatar_url || '' }
}

function authorBrief(u) {
    return u ? { username: u.username || '', url: u.permalink_url || '' } : { username: '', url: '' }
}

function trackLight(t) {
    return {
        type: 'track', id: t.id, title: t.title, url: t.permalink_url,
        author: authorBrief(t.user),
        duration: dur(t.duration), durationMs: t.duration,
        stats: { playback: t.playback_count ?? 0, likes: t.likes_count ?? 0 },
        genre: t.genre || '', artwork: t.artwork_url || _visArt(t), downloadable: !!t.downloadable
    }
}

function trackFull(t) {
    return {
        status: 'success', type: 'track', id: t.id, url: t.permalink_url, title: t.title,
        description: t.description || t.caption || '', author: author(t.user),
        duration: dur(t.duration), durationMs: t.duration, fullDurationMs: t.full_duration,
        genre: t.genre || '',
        tags: (t.tag_list || '').split(/\s+/).filter(x => x && !x.startsWith('tag:')),
        artwork: artAll(t.artwork_url, _visArt(t)), waveform: t.waveform_url || '',
        stats: { playback: t.playback_count ?? 0, likes: t.likes_count ?? 0, comments: t.comment_count ?? 0, downloads: t.download_count ?? 0, reposts: t.reposts_count ?? 0 },
        dates: { created: t.created_at || '', modified: t.last_modified || '', released: t.display_date || '' },
        license: t.license || '', label: t.label_name || '',
        purchase: { title: t.purchase_title || '', url: t.purchase_url || '' },
        downloadable: !!t.downloadable, hasDownloadsLeft: !!t.has_downloads_left,
        embeddableBy: t.embeddable_by || '', public: !!t.public,
        monetization: t.monetization_model || '', policy: t.policy || '',
        publisherMetadata: t.publisher_metadata || {},
        streams: ((t.media || {}).transcodings || []).map(x => ({
            preset: x.preset, protocol: (x.format || {}).protocol, mime: (x.format || {}).mime_type,
            quality: x.quality, durationMs: x.duration, url: x.url
        })),
        watermark: WM
    }
}

function userFull(u, tracks) {
    return {
        status: 'success', type: 'user', id: u.id, url: u.permalink_url,
        username: u.username || '', fullName: u.full_name || u.username || '', bio: u.description || '',
        city: u.city || '', countryCode: u.country_code || '',
        avatar: artAll(u.avatar_url, _visArt(u)), banner: u.banner_url || '', website: u.website || '',
        stats: { followers: u.followers_count ?? 0, following: u.followings_count ?? 0, tracks: u.track_count ?? 0, playlists: u.playlist_count ?? 0, likes: u.likes_count ?? 0 },
        created: u.created_at || '', verified: !!u.verified,
        ...(tracks ? { trackCount: tracks.length, tracks } : {}),
        watermark: WM
    }
}

function userBrief(u) {
    return {
        type: 'user', id: u.id ?? 0, username: u.username || '', url: u.permalink_url || '',
        fullName: u.full_name || u.username || '', verified: !!u.verified,
        followers: u.followers_count ?? 0, tracks: u.track_count ?? 0,
        avatar: u.avatar_url || ''
    }
}

function plBrief(p) {
    return {
        type: 'playlist', id: p.id, title: p.title, url: p.permalink_url, isAlbum: !!p.is_album,
        author: authorBrief(p.user), genre: p.genre || '',
        stats: { tracks: p.track_count ?? 0, likes: p.likes_count ?? 0, reposts: p.reposts_count ?? 0 },
        duration: dur(p.duration), artwork: p.artwork_url || _visArt(p), created: p.created_at || ''
    }
}

function plFull(p, tracks) {
    return {
        status: 'success', type: 'playlist', id: p.id, url: p.permalink_url, title: p.title,
        isAlbum: !!p.is_album, genre: p.genre || '', description: p.description || '',
        author: author(p.user), artwork: artAll(p.artwork_url, _visArt(p)),
        stats: { tracks: p.track_count ?? 0, likes: p.likes_count ?? 0, reposts: p.reposts_count ?? 0 },
        duration: dur(p.duration), durationMs: p.duration || 0,
        created: p.created_at || '', lastModified: p.last_modified || '',
        tracks, watermark: WM
    }
}

function commentShape(c) {
    return {
        id: c.id, body: c.body,
        timestamp: c.timestamp ?? 0,
        at: c.timestamp != null ? dur(c.timestamp) : '',
        createdAt: c.created_at || '',
        parentId: c.parent_id || 0,
        user: c.user ? userBrief(c.user) : { type: 'user', id: 0, username: '', url: '', fullName: '', verified: false, followers: 0, tracks: 0, avatar: '' }
    }
}

// hydrate stub playlist tracks
async function hydrateTracks(list) {
    const out = list.slice()
    const need = []
    out.forEach((t, i) => { if (t && t.id && !t.title) need.push([i, t.id]) })
    if (!need.length) return out.filter(t => t && t.title)
    const ids = [...new Set(need.map(x => x[1]))]
    const map = new Map()
    for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50)
        const d = await apiGet('/tracks', { ids: chunk.join(',') })
        for (const t of d) if (t && t.id) map.set(t.id, t)
    }
    for (const [i, id] of need) { const full = map.get(id); if (full) out[i] = full }
    return out.filter(t => t && t.title)
}

function ffmpegOk() {
    try { return spawnSync('ffmpeg', ['-version'], { timeout: 8000 }).status === 0 } catch { return false }
}

async function dlAll(urls, conc) {
    const out = new Array(urls.length)
    let i = 0
    async function worker() {
        while (i < urls.length) {
            const idx = i++
            const r = await retrying('segmen ' + idx, async () => {
                const res = await CDN_SCHED.schedule(() => CDN_SCHED.gate().then(() => httpGet(urls[idx], { timeout: 12000, binary: true, strategy: 'cdn' })))
                if (res.status !== 200) throw mkFail('network', 'segment http ' + res.status)
                return res
            }, { tries: 5 })
            out[idx] = r.body
        }
    }
    await Promise.all(Array.from({ length: Math.min(conc, urls.length) }, worker))
    return out
}

export async function download(input, { file = null, quality = 'aac' } = {}) {
    const t0 = Date.now()
    const t = await resolve(input)
    if (t.kind !== 'track') throw mkFail('bad_input', 'url is not a track but ' + t.kind)
    const trs = (t.media || {}).transcodings || []
    if (!trs.length) throw mkFail('not_found', 'no stream available private or premium')
    const want = quality === 'sq' ? ['abr_sq', 'aac_96k', 'hls_64'] : ['aac_96k', 'abr_sq', 'hls_64']
    const cands = []
    for (const p of want) { const x = trs.find(y => y.preset === p); if (x) cands.push(x) }
    for (const x of trs) if (!cands.includes(x)) cands.push(x)
    let tr = null, pl = null
    for (const c of cands) {
        const url = c.url + (c.url.includes('?') ? '&' : '?') + 'client_id=' + CID
        let r = null
        try {
            r = await retrying('transcoding', async () => {
                const res = await API_SCHED.schedule(() => API_SCHED.gate().then(() => httpGet(url)))
                if (res.status !== 200) throw mkFail('unknown', 'transcoding http ' + res.status)
                return res
            }, { tries: 2 })
        } catch { continue }
        try { const j = JSON.parse(r.body); if (j.url) { tr = c; pl = j.url; break } } catch {}
    }
    if (!tr) throw mkFail('not_found', 'all stream presets failed private or premium')
    const cdnHost = new URL(pl).hostname
    resolve4(cdnHost).catch(() => {})
    const r2 = await retrying('m3u8', async () => {
        const res = await CDN_SCHED.schedule(() => CDN_SCHED.gate().then(() => httpGet(pl, { timeout: 30000, strategy: 'cdn' })))
        if (res.status !== 200) throw mkFail('network', 'm3u8 http ' + res.status)
        return res
    })
    const text = String(r2.body)
    const initM = text.match(/#EXT-X-MAP:URI="([^"]+)"/)
    const segs = text.split('\n').filter(l => l.startsWith('http'))
    const parts = []
    if (initM) {
        const ri = await retrying('init', async () => {
            const res = await CDN_SCHED.schedule(() => CDN_SCHED.gate().then(() => httpGet(initM[1], { timeout: 60000, binary: true, strategy: 'cdn' })))
            if (res.status !== 200) throw mkFail('network', 'init segment http ' + res.status)
            return res
        })
        parts.push(ri.body)
    }
    const bodies = await dlAll(segs, 8)
    const raw = Buffer.concat([...parts, ...bodies])
    const mime = (tr.format || {}).mime_type || ''
    const isOpus = /opus/i.test(mime) || /abr_sq|opus/i.test(tr.preset || '')
    const ff = ffmpegOk()
    const base = (t.title || 'soundcloud').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'soundcloud'
    let out = file || (base + (isOpus && ff ? '.opus' : '.m4a'))
    const ext = isOpus ? 'opus' : 'm4a'
    if (!/\.[a-z0-9]{2,5}$/i.test(out)) out += '.' + ext
    const tmp = out + '.part.raw'
    fs.writeFileSync(tmp, raw)
    let engine = 'raw-concat', embedded = false
    if (ff) {
        const args = ['-y', '-i', tmp, '-c', 'copy', '-metadata', 'title=' + (t.title || ''), '-metadata', 'artist=' + ((t.user || {}).username || '')]
        const dst = isOpus ? out.replace(/\.[^.]*$/, '') + '.opus' : out
        args.push(dst)
        const r = spawnSync('ffmpeg', args, { timeout: 120000 })
        fs.unlinkSync(tmp)
        if (r.status === 0) { engine = 'ffmpeg-remux'; embedded = true; out = dst }
        else { fs.writeFileSync(out, raw); engine = 'raw-concat (ffmpeg gagal)' }
    } else fs.renameSync(tmp, out)
    return {
        status: 'success', type: 'mp3',
        title: t.title, author: (t.user || {}).username,
        url: t.permalink_url, duration: dur(t.duration), durationMs: t.duration,
        file: out, ext: isOpus ? 'opus' : 'm4a', mimetype: isOpus ? 'audio/ogg' : 'audio/mp4',
        size: { bytes: raw.length, mb: +(raw.length / 1048576).toFixed(2) },
        preset: tr.preset, mime, segments: segs.length,
        engine, metadataEmbedded: embedded,
        timeSec: +((Date.now() - t0) / 1000).toFixed(2), watermark: WM
    }
}

export async function search(q, { limit = 20, scope = 'all' } = {}) {
    const ep = scope && scope !== 'all' ? '/search/' + scope : '/search'
    const d = await apiGet(ep, { q, limit: Math.min(Math.max(limit, 1), 50) })
    const results = (d.collection || []).map(x => {
        if (x.kind === 'user') return userBrief(x)
        if (x.kind === 'playlist') return plBrief(x)
        return trackLight(x)
    })
    return { status: 'success', type: 'search', query: q, scope: scope || 'all', count: results.length, next: d.next_href || '', results, watermark: WM }
}

export async function suggest(q, { limit = 10 } = {}) {
    const lim = Math.min(Math.max(limit, 1), 20)
    const [quiet, tags] = await Promise.all([
        apiGet('/search/queries', { q, limit: lim }),
        apiGet('/search/suggest/tags', { q, limit: lim }).catch(() => ({ suggestions: [] }))
    ])
    const strip = s => String(s || '').replace(/<[^>]+>/g, '')
    return {
        status: 'success', type: 'suggest', query: q,
        queries: (quiet.collection || []).map(x => x.query || x.output).filter(Boolean),
        tags: (tags.suggestions || []).map(x => {
            const label = strip(x.query)
            const tag = String(x.id || label).toLowerCase()
            return { tag, label, url: 'https://soundcloud.com/you/sounds/' + tag }
        }),
        watermark: WM
    }
}

async function asUser(input) {
    let u = await resolve(input)
    if (u.kind === 'track' || u.kind === 'playlist') u = await resolve((u.user || {}).permalink_url)
    if (u.kind !== 'user') throw mkFail('bad_input', 'target is not a user but ' + u.kind)
    return u
}

export async function user(input, { limit = 20 } = {}) {
    const u = await asUser(input)
    const first = await apiGet('/users/' + u.id + '/tracks', { limit: Math.min(limit, 50), linked_partitioning: 1 })
    const tracks = await pageAll(first, trackLight, limit)
    return userFull(u, tracks)
}

export async function likes(input, { limit = 20 } = {}) {
    const u = await asUser(input)
    const first = await apiGet('/users/' + u.id + '/likes', { limit: Math.min(limit, 50), linked_partitioning: 1 })
    const items = await pageAll(first, x => {
        const t = x.track || x.playlist
        return t ? (t.kind === 'playlist' ? plBrief(t) : trackLight(t)) : null
    }, limit)
    return { status: 'success', type: 'likes', user: userBrief(u), count: items.length, items, watermark: WM }
}

export async function toptracks(input, { limit = 20 } = {}) {
    const u = await asUser(input)
    const first = await apiGet('/users/' + u.id + '/toptracks', { limit: Math.min(limit, 50), linked_partitioning: 1 })
    const tracks = await pageAll(first, trackLight, limit)
    return { status: 'success', type: 'toptracks', user: userBrief(u), count: tracks.length, tracks, watermark: WM }
}

export async function followers(input, { limit = 50 } = {}) {
    const u = await asUser(input)
    const first = await apiGet('/users/' + u.id + '/followers', { limit: Math.min(limit, 50), linked_partitioning: 1 })
    const users = await pageAll(first, userBrief, limit)
    return { status: 'success', type: 'followers', user: userBrief(u), count: users.length, users, watermark: WM }
}

export async function following(input, { limit = 50 } = {}) {
    const u = await asUser(input)
    const first = await apiGet('/users/' + u.id + '/followings', { limit: Math.min(limit, 50), linked_partitioning: 1 })
    const users = await pageAll(first, userBrief, limit)
    return { status: 'success', type: 'following', user: userBrief(u), count: users.length, users, watermark: WM }
}

export async function playlist(input, { limit = 50 } = {}) {
    const p = await resolve(input)
    if (p.kind !== 'playlist') throw mkFail('bad_input', 'target is not a playlist but ' + p.kind)
    const hydrated = await hydrateTracks((p.tracks || []).slice(0, limit))
    const tracks = hydrated.map((t, i) => ({ ...trackLight(t), position: i + 1 }))
    return plFull(p, tracks)
}

export async function related(input, { limit = 10 } = {}) {
    const t = await resolve(input)
    if (t.kind !== 'track') throw mkFail('bad_input', 'target is not a track but ' + t.kind)
    const d = await apiGet('/tracks/' + t.id + '/related', { limit: Math.min(Math.max(limit, 1), 50) })
    return { status: 'success', type: 'related', seed: { id: t.id, title: t.title, url: t.permalink_url }, count: (d.collection || []).length, tracks: (d.collection || []).map(trackLight), watermark: WM }
}

export async function comments(input, { limit = 20 } = {}) {
    const t = await resolve(input)
    if (t.kind !== 'track') throw mkFail('bad_input', 'target is not a track but ' + t.kind)
    const first = await apiGet('/tracks/' + t.id + '/comments', { threaded: 0, limit: Math.min(limit, 200), linked_partitioning: 1 })
    const list = await pageAll(first, commentShape, limit)
    return {
        status: 'success', type: 'comments',
        track: { id: t.id, title: t.title, url: t.permalink_url, total: t.comment_count ?? 0 },
        count: list.length, comments: list, watermark: WM
    }
}

export async function trackPlaylists(input, { limit = 20 } = {}) {
    const t = await resolve(input)
    if (t.kind !== 'track') throw mkFail('bad_input', 'target is not a track but ' + t.kind)
    const first = await apiGet('/tracks/' + t.id + '/playlists', { limit: Math.min(limit, 50), linked_partitioning: 1 })
    const playlists = await pageAll(first, p => (p && p.kind === 'playlist' ? plBrief(p) : null), limit)
    return { status: 'success', type: 'playlists', track: { id: t.id, title: t.title, url: t.permalink_url }, count: playlists.length, playlists, watermark: WM }
}

export async function charts({ genre = 'all-music', limit = 20 } = {}) {
    const urn = /^soundcloud:genres:/.test(genre) ? genre : 'soundcloud:genres:' + genre
    let d
    try {
        d = await apiGet('/charts', { kind: 'trending', genre: urn, limit: Math.min(Math.max(limit, 1), 50) })
    } catch (e) {
        if (e.kind === 'not_found') throw mkFail('not_found', 'chart genre not available api only serves all-music')
        throw e
    }
    const list = (d.collection || []).map((x, i) => ({ rank: i + 1, score: x.score ?? 0, track: trackLight(x.track || {}) }))
    return { status: 'success', type: 'charts', kind: 'trending', genre: d.genre || genre, updated: d.last_updated || '', count: list.length, charts: list, watermark: WM }
}

export async function tag(name, { limit = 20 } = {}) {
    const first = await apiGet('/recent-tracks/' + encodeURIComponent(name), { limit: Math.min(limit, 50), linked_partitioning: 1 })
    const tracks = await pageAll(first, trackLight, limit)
    return { status: 'success', type: 'tag', tag: name, count: tracks.length, tracks, watermark: WM }
}

export async function info(input) {
    const d = await resolve(input)
    if (d.kind === 'track') return trackFull(d)
    if (d.kind === 'user') return userFull(d)
    if (d.kind === 'playlist') {
        const hydrated = await hydrateTracks(d.tracks || [])
        const tracks = hydrated.map((t, i) => ({ ...trackLight(t), position: i + 1 }))
        return plFull(d, tracks)
    }
    return { status: 'success', type: d.kind || 'unknown', data: d, watermark: WM }
}

// CLI
const isNum = s => /^\d+$/.test(String(s || ''))

async function main() {
    const [, , a1, a2, a3, a4] = process.argv
    if (!a1 || a1 === 'help') {
        console.log('pakai: node sndCl.mjs <url> [info]                    metadata penuh')
        console.log('       node sndCl.mjs <url> mp3 [file] [sq|aac]        unduh audio')
        console.log('       node sndCl.mjs search "<q>" [limit] [scope]    all|tracks|users|playlists|albums')
        console.log('       node sndCl.mjs suggest "<q>" [limit]           autocomplete query + tag')
        console.log('       node sndCl.mjs <user-url> user [limit]         profil + track user')
        console.log('       node sndCl.mjs <user-url> likes [limit]        track yang di-like user')
        console.log('       node sndCl.mjs <user-url> toptracks [limit]    top track user')
        console.log('       node sndCl.mjs <user-url> followers [limit]    follower user')
        console.log('       node sndCl.mjs <user-url> following [limit]    following user')
        console.log('       node sndCl.mjs <pl-url> pl [limit]             isi playlist/album')
        console.log('       node sndCl.mjs <track-url> related [limit]     track serupa')
        console.log('       node sndCl.mjs <track-url> comments [limit]    komentar track')
        console.log('       node sndCl.mjs <track-url> playlists [limit]   playlist yang memuat track')
        console.log('       node sndCl.mjs tag "<tag>" [limit]             recent tracks per tag')
        console.log('       node sndCl.mjs charts [genre] [limit]          trending charts')
        process.exit(1)
    }
    if (a1 === 'search') {
        if (!a2) throw mkFail('bad_input', 'search needs query')
        return search(a2, { limit: Number(a3) || 20, scope: a4 || 'all' })
    }
    if (a1 === 'suggest') {
        if (!a2) throw mkFail('bad_input', 'suggest needs query')
        return suggest(a2, { limit: Number(a3) || 10 })
    }
    if (a1 === 'tag') {
        if (!a2) throw mkFail('bad_input', 'tag needs tag name')
        return tag(a2, { limit: Number(a3) || 20 })
    }
    if (a1 === 'charts') {
        const genre = a2 && !isNum(a2) ? a2 : 'all-music'
        const lim = isNum(a2) ? a2 : a3
        return charts({ genre, limit: Number(lim) || 20 })
    }
    const url = a1.startsWith('http') ? a1 : 'https://soundcloud.com/' + a1.replace(/^\/+/, '')
    if (a2 === 'mp3') {
        let file = null, quality = 'aac'
        for (const a of [a3, a4]) { if (a === 'sq' || a === 'aac') quality = a; else if (a && !file) file = a }
        return download(url, { file, quality })
    }
    if (a2 === 'user') return user(url, { limit: Number(a3) || 20 })
    if (a2 === 'likes') return likes(url, { limit: Number(a3) || 20 })
    if (a2 === 'toptracks') return toptracks(url, { limit: Number(a3) || 20 })
    if (a2 === 'followers') return followers(url, { limit: Number(a3) || 50 })
    if (a2 === 'following') return following(url, { limit: Number(a3) || 50 })
    if (a2 === 'pl') return playlist(url, { limit: Number(a3) || 50 })
    if (a2 === 'related') return related(url, { limit: Number(a3) || 10 })
    if (a2 === 'comments') return comments(url, { limit: Number(a3) || 20 })
    if (a2 === 'playlists') return trackPlaylists(url, { limit: Number(a3) || 20 })
    return info(url)
}

if (process.argv[1] && import.meta.url.endsWith('/' + process.argv[1].split('/').pop())) {
    main()
        .then(r => { console.log(JSON.stringify(r, null, 2)) })
        .catch(e => {
            failOut(e, { watermark: WM })
            process.exitCode = 1
        })
}
