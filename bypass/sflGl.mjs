#!/usr/bin/env node
/*
Base    : https://sfl.gl
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Bypass SafelinkU (sfl.gl): lewatin halaman iklan + countdown, langsung dapet URL tujuan
- Ikutin chain asli situs (shortlink -> redirect -> token anti-bot -> verify -> go -> file page) — nggak ada API pihak ketiga, nggak butuh key/login/browser
- Output JSON: URL tujuan, host tujuan, dan seluruh redirect chain
- Cepat (~0.6-1.5 detik). Token anti-bot di-cache 4 menit, jadi link berikutnya nggak ngulang halaman slug; token basi (419) diambil ulang otomatis
- Batch: banyak link sekaligus -> JSON array
- Nol dependency, Node >= 18

Usage:
  node sflGl.mjs <url|alias>           JSON: {success, original_url, alias, destination_url,
                                              destination_host, redirect_chain,
                                              elapsedMs, rounds}
  node sflGl.mjs <url|alias> hop       berhenti di hasil /api/go (sebelum file page)
  node sflGl.mjs <url|alias> fresh      paksa ambil token baru (skip cache)
  node sflGl.mjs <url> <url> ...        batch -> JSON array

Contoh:
  node sflGl.mjs https://sfl.gl/PdKKCb
  node sflGl.mjs PdKKCb hop
  node sflGl.mjs PdKKCb PdKKCb
*/

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import https from 'node:https'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const WM = 'VenzioLûx — Vloûte Cataclysm'
const SRC = 'sfl.gl'
const CACHE = path.join(os.tmpdir(), 'sflGl-tt.json')
const TT_TTL = 240e3
const DESTS = /download|get\s*link|continue|lanjut|kembali|click\s*here/i

const webMsg = (r) => {
    const t = (r.text() || '').trim()
    try {
        const j = JSON.parse(t)
        if (j && (j.message || j.error)) return String(j.message || j.error)
    } catch { }
    const m = /<title[^>]*>\s*([^<]+?)\s*<\/title>/i.exec(t)
    return m ? m[1] : t.replace(/\s+/g, ' ').slice(0, 120)
}

const bad = (where, r) => {
    const e = new Error(`${where} http ${r.status} ${webMsg(r)}`.trim().toLowerCase())
    e.status = r.status
    throw e
}

const jsonOf = (r) => {
    try { return JSON.parse(r.text()) } catch { return null }
}

const kindOf = (e) => {
    const s = (e && e.status) || 0
    if (s === 404) return 'not_found'
    if (s === 400) return 'bad_input'
    if (s === 403 || s === 419 || s === 429) return 'ip_blocked'
    if (s >= 500) return 'service_down'
    const m = String((e && e.message) || '').toLowerCase()
    if (/captcha|just a moment|challenge/.test(m)) return 'ip_blocked'
    if (/form not found|page changed|pattern changed/.test(m)) return 'parse_changed'
    if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|timeout|network/.test(m)) return 'network'
    return 'unknown'
}

const failOut = (e) => {
    console.log(JSON.stringify({
        success: false,
        kind: kindOf(e),
        error: (e && e.message) || 'unknown error',
    }, null, 2))
    process.exit(1)
}


const ipPref = new Map()
const dnsCache = new Map()
const resolve4 = async (host) => {
    const c = dnsCache.get(host)
    if (c && c.exp > Date.now()) return c.ips
    const ips = (await dns.promises.lookup(host, { all: true, family: 4 })).map(x => x.address)
    dnsCache.set(host, { ips, exp: Date.now() + 300e3 })
    return ips
}
const tryOne = (ip, timeout) => new Promise((resolve, reject) => {
    const s = net.connect({ host: ip, port: 443, family: 4, autoSelectFamily: false })
    const t = setTimeout(() => { s.destroy(); reject(new Error(`timeout ${timeout}ms`)) }, timeout)
    s.once('connect', () => { clearTimeout(t); resolve(s) })
    s.once('error', (e) => { clearTimeout(t); s.destroy(); reject(e) })
})

const fastTCP = async (host) => {
    let ips
    try {
        ips = await resolve4(host)
    } catch (e) {
        throw new Error(`dns ${host} failed: ${e.message}`)
    }
    if (!ips.length) throw new Error(`dns ${host} returned no ipv4`)
    const pref = ipPref.get(host)
    const order = pref && ips.includes(pref) ? [pref, ...ips.filter(i => i !== pref)] : ips
    const deadline = Date.now() + 10000
    let waves = 0
    let lastErr = ''
    while (Date.now() < deadline) {
        waves++
        const jobs = order.map((ip, i) => (i === 0 ? tryOne(ip, 320)
            : new Promise(r => setTimeout(r, 80)).then(() => tryOne(ip, 320))))
        const res = await Promise.allSettled(jobs)
        const win = res.find(r => r.status === 'fulfilled')
        if (win) {
            ipPref.set(host, order[res.indexOf(win)])
            return win.value
        }
        lastErr = res.map(r => r.reason?.message).join(' | ')
    }
    throw new Error(`connect ${host} failed after ${waves} waves ${lastErr}`)
}

class FastAgent extends https.Agent {
    createConnection(options, cb) {
        const host = options.host || options.hostname || options.servername
        fastTCP(host).then((sock) => {
            const s = tls.connect({ socket: sock, servername: host, ALPNProtocols: ['http/1.1'] }, () => cb(null, s))
            s.once('error', cb)
        }, cb)
    }
}

const AGENT = new FastAgent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 60000 })

const hit = (url, opt = {}) => new Promise((resolve, reject) => {
    const u = new URL(url)
    const t0 = performance.now()
    const body = opt.body ? Buffer.from(opt.body) : null
    const req = https.request({
        agent: AGENT,
        hostname: u.hostname,
        port: u.port || 443,
        servername: u.hostname,
        method: opt.method || 'GET',
        path: u.pathname + u.search,
        headers: {
            'user-agent': UA,
            host: u.host,
            accept: opt.accept || '*/*',
            ...(opt.headers || {}),
            ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
        },
    }, (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({
            status: res.statusCode,
            headers: res.headers,
            setCookie: res.headers['set-cookie'] || [],
            ms: performance.now() - t0,
            text: () => Buffer.concat(chunks).toString('utf8'),
            json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }))
        res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('request timeout 20s')))
    if (body) req.write(body)
    req.end()
})

const request = async (url, opt = {}, tries = 2) => {
    for (let i = 0; ; i++) {
        try {
            return await hit(url, opt)
        } catch (e) {
            if (i >= tries - 1) throw new Error(`${url} failed ${e.message}`)
            await new Promise(r => setTimeout(r, 200))
        }
    }
}

const jar = (setCookie) => {
    const m = {}
    for (const line of setCookie) {
        const pair = line.split(';')[0]
        const i = pair.indexOf('=')
        if (i > 0) m[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
    }
    return m
}
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return null } }

const cacheRead = () => {
    try {
        const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
        return (c && typeof c === 'object') ? c : {}
    } catch { return {} }
}
const cacheWrite = (c) => { try { fs.writeFileSync(CACHE, JSON.stringify(c)) } catch { } }
const ttRead = () => {
    const c = cacheRead()
    return (c.tt && c.when > Date.now() - TT_TTL) ? c.tt : null
}
const ttDrop = () => {
    const c = cacheRead()
    delete c.tt
    delete c.when
    cacheWrite(c)
}

const ttFromPage = async (slugUrl, session) => {
    const r = await request(slugUrl, { accept: 'text/html,*/*;q=0.8', headers: { cookie: `__session=${session}` } })
    if (r.status !== 200) bad('slug page', r)
    const c = jar(r.setCookie)
    if (!c.tt) throw new Error('slug page returned no tt cookie')
    cacheWrite({ ...cacheRead(), tt: c.tt, when: Date.now() })
    return c.tt
}

const isShortlink = (u) => /^https?:\/\/(www\.)?sfl\.gl\//i.test(u) && !/\/ready\/go/.test(u)
const isSflHost = (u) => { try { return /(^|\.)sfl\.gl$/i.test(new URL(u).hostname) } catch { return false } }
const parseDest = (html, pageHost) => {
    let best = { url: null, score: 0 }
    for (const m of html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const href = m[1].replace(/&amp;/g, '&')
        const text = m[2].replace(/<[^>]+>/g, ' ').trim()
        if (!/^https?:\/\//i.test(href)) continue
        if (/^https?:\/\/(www\.)?(safelinku|facebook|twitter|x|t\.me|khaddavi)\./i.test(href)) continue
        const host = hostOf(href)
        if (!host) continue
        let score = 0
        if (DESTS.test(text)) score += 3
        if (/\.(js|zip|apk|mp4|mp3|pdf|png|jpe?g|txt|xml)(\?|$)/i.test(href)) score += 2
        if (host !== pageHost) score += 1
        if (score > best.score) best = { url: href, score }
    }
    
    if (!best.url) {
        const loc = /location\.href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1]?.replace(/\\\//g, '/')
        if (loc) best = { url: loc, score: 1 }
    }
    return { url: best.score > 0 ? best.url : null }
}

const toUrl = (raw) => {
    const s = String(raw || '').trim()
    if (!s) return null
    if (/^https?:\/\//i.test(s)) return s
    if (/^[A-Za-z0-9_-]{4,12}$/.test(s)) return `https://sfl.gl/${s}`
    return null
}

async function resolve(link, opts = {}) {
    const T0 = performance.now()
    const chain = []
    const a = await request(link, { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' })
    if (a.status !== 200) bad('sfl.gl', a)
    const html = a.text()
    chain.push(link)
    const action = /<form[^>]*\baction="([^"]+)"/i.exec(html)?.[1]
    const rayId = /name="ray_id"[^>]*\bvalue="([^"]+)"/i.exec(html)?.[1]
    const alias = /name="alias"[^>]*\bvalue="([^"]+)"/i.exec(html)?.[1]  // buat param /api/verify
    if (!action || !rayId || !alias) {
        if (/just a moment|cf-challenge/i.test(html)) throw new Error('sfl.gl cloudflare challenge page')
        throw new Error('sfl.gl form not found link gone or page changed')
    }
    const origin = new URL(action).origin
    const hop = new URL(action)
    hop.search = new URLSearchParams({ ray_id: rayId, alias }).toString()
    const b = await request(hop.toString(), { accept: 'text/html,*/*;q=0.8', headers: { referer: link } })
    if (b.status !== 302 && b.status !== 200) bad('redirect.php', b)
    const cB = jar(b.setCookie)
    const loc = b.headers.location
    if (!loc || !cB.__session) throw new Error('redirect.php returned no location or session cookie')
    const slug = new URL(loc, origin)
    let tt = opts.fresh ? null : ttRead()
    if (!tt) tt = await ttFromPage(slug.toString(), cB.__session)
    let cookie = `__session=${cB.__session}; tt=${tt}`
    const post = async (p, body) => request(new URL(p, origin).toString(), {
        method: 'POST',
        accept: 'application/json',
        headers: {
            'content-type': 'application/json', origin,
            referer: slug.toString(), 'x-requested-with': 'XMLHttpRequest', cookie,
        },
        body: JSON.stringify(body),
    })

    let v = await post('/api/verify', { _a: 0 })
    if (v.status === 419 || v.status === 422) {
        ttDrop()
        tt = await ttFromPage(slug.toString(), cB.__session)
        cookie = `__session=${cB.__session}; tt=${tt}`
        v = await post('/api/verify', { _a: 0 })
    }
    if (v.status !== 200) bad('/api/verify', v)

    const key = Math.floor(Math.random() * 1e3)
    const goBody = () => ({ key, size: `${(1920 + key) * 2}.${(1080 + key) * 2}`, ado: null })
    let g = await post('/api/go', goBody())
    let gj = g.status === 200 ? jsonOf(g) : null
    if (!gj?.url) {
        await post('/api/session', { _token: 'slf' })
        await post('/api/verify', { _a: 0 })
        g = await post('/api/go', goBody())
        gj = g.status === 200 ? jsonOf(g) : null
    }
    if (!gj?.url) bad('/api/go', g)

    let url = String(gj.url).replace(/&amp;/g, '&')
    chain.push(url)
    if (!opts.stopAtHop) {
        let depth = opts._depth || 0
        while (depth++ < 5) {
            if (!isSflHost(url)) break
            const pageHost = hostOf(url)
            let f
            try {
                f = await request(url, { accept: 'text/html,*/*;q=0.8', headers: { referer: slug.toString() } })
            } catch { break }
            if (f.status !== 200 || !/text\/html/i.test(String(f.headers['content-type']))) break
            const d = parseDest(f.text(), pageHost)
            if (!d.url) break
            if (isShortlink(d.url)) {
                const sub = await resolve(d.url, { fresh: false, _depth: depth })
                url = sub.destination_url
                chain.push(...sub.redirect_chain)
                break
            }
            url = d.url
            chain.push(url)
        }
    }

    return {
        original_url: link,
        alias: alias || null,
        destination_url: url,
        destination_host: hostOf(url) || '',
        redirect_chain: chain,
        elapsedMs: Math.round(performance.now() - T0), watermark: WM, source: SRC,
    }
}

async function resolveRetry(link, opts = {}) {
    const maxRound = opts.maxRound ?? 3
    let lastErr = null
    for (let round = 0; round < maxRound; round++) {
        try {
            const r = await resolve(link, { ...opts, fresh: round > 0 ? true : opts.fresh })
            r.rounds = round + 1
            return r
        } catch (e) {
            lastErr = e
            if (e.status === 419 || e.status === 422 || e.status === 429) {
                ttDrop()
                await new Promise(res => setTimeout(res, 700 * (round + 1) + Math.floor(Math.random() * 400)))
                continue
            }
            if (kindOf(e) === 'network') {
                await new Promise(res => setTimeout(res, 300 * (round + 1)))
                continue
            }
            throw e
        }
    }
    throw lastErr || new Error('resolve failed after retries')
}

function help() {
    const t = fs.readFileSync(process.argv[1], 'utf8')
    const m = t.match(/Usage:\n([\s\S]*?)\n\*\//)
    console.log(m ? m[1].replace(/^ {2}/gm, '') : 'node sflGl.mjs <url|alias> [json|hop|fresh]')
}

async function main() {
    const argv = process.argv.slice(2)
    const flags = { hop: false, fresh: false }
    const inputs = []
    for (const a of argv) {
        if (a === 'hop' || a === '--hop') { flags.hop = true; continue }
        if (a === 'fresh' || a === '--fresh') { flags.fresh = true; continue }
        if (a === 'json' || a === '--json') continue
        if (a === '-h' || a === '--help' || a === 'help') { help(); return }
        inputs.push(a)
    }
    if (!inputs.length) { help(); process.exitCode = 1; return }

    const out = []
    let failed = 0
    for (const raw of inputs) {
        const link = toUrl(raw)
        if (!link) {
            failed++
            out.push({
                success: false,
                original_url: String(raw),
                kind: 'bad_input',
                error: 'input must be full url or sfl.gl alias 4-12 chars',
                watermark: WM, source: SRC,
            })
            continue
        }
        try {
            const r = await resolveRetry(link, {
                stopAtHop: flags.hop, fresh: flags.fresh,
            })
            out.push({ success: true, ...r })
        } catch (e) {
            failed++
            out.push({
                success: false,
                original_url: link,
                kind: kindOf(e),
                error: (e && e.message) || 'unknown error',
                watermark: WM, source: SRC,
            })
        }
    }
    console.log(out.length === 1 ? JSON.stringify(out[0], null, 2) : JSON.stringify(out, null, 2))
    process.exitCode = failed ? 1 : 0
}

main().catch(e => failOut(e))
