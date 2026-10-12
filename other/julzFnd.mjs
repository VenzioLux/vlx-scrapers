#!/usr/bin/env node
/*
Base    : https://julzpreset-finder.vercel.app
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Cari URL preset Alight Motion (tipe 5mb dan XML) dari video TikTok / YouTube / Instagram
- Metadata lengkap: judul, deskripsi, author, view, like, komentar, share, cover
- Info preset: url, sumber (komentar/balasan), oleh author atau bukan
- Nol dependency, Node >= 18. Cache cookie am_c biar nggak handshake ulang tiap panggilan.

Catatan:
- Situs pakai cookie gate `am_c` (timestamp.hash). Hash-nya divalidasi server,
  jadi nggak bisa dikarang — tapi bisa diambil dari respons HTML pertama.
- Cache cookie-nya disimpan di /tmp supaya nggak re-fetch tiap kali.
- Ganti situs ini kalau butuh tanpa cache: cukup hapus cache am_c dulu.

Usage:
  node julzFnd.mjs <url>          cari preset, JSON
  node julzFnd.mjs <url> presets  hanya daftar preset
  node julzFnd.mjs <url> open     buka semua url preset di browser

Contoh:
  node julzFnd.mjs https://vt.tiktok.com/ZSbx4DMPA/
  node julzFnd.mjs https://vt.tiktok.com/ZSbx4DMPA/ presets
*/

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SITE = 'https://julzpreset-finder.vercel.app'
const API = `${SITE}/api/find`
const CACHE = path.join(os.tmpdir(), 'julz-am_c.json')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const arg = () => {
    const a = process.argv.slice(2)
    if (!a.length || a[0] === '-h' || a[0] === '--help') {
        console.log(`Usage:\n  node julzFnd.mjs <url> [presets|open]\n\nEx:\n  node julzFnd.mjs https://vt.tiktok.com/ZSbx4DMPA/`)
        process.exit(a.length ? 0 : 1)
    }
    return a
}

function cachedCookie() {
    try {
        const { cookie, when } = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
        if (when > Date.now() - 3600e3) return cookie
    } catch { }
    return null
}

function saveCookie(c) { fs.writeFileSync(CACHE, JSON.stringify({ cookie: c, when: Date.now() })) }

async function handshake() {
    const hit = cachedCookie()
    if (hit) return hit
    const r = await fetch(SITE + '/', { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } })
    const body = await r.text()
    const m = body.match(/am_c=([0-9a-f]+\.[0-9a-f]+)/)
    if (!m) throw new Error('cookie am_c nggak ketemu — situsnya mungkin lagi 403/rate-limit')
    const cookie = `am_c=${m[1]}`
    saveCookie(cookie)
    return cookie
}

async function api(url) {
    const cookie = await handshake()
    let r = await fetch(`${API}?url=${encodeURIComponent(url)}`, {
        headers: { 'user-agent': UA, cookie, accept: 'application/json' },
    })
    if (r.status === 403) {
        fs.rmSync(CACHE, { force: true })
        const fresh = await handshake()
        r = await fetch(`${API}?url=${encodeURIComponent(url)}`, {
            headers: { 'user-agent': UA, cookie: fresh, accept: 'application/json' },
        })
    }
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
    if (j.ok === false) throw new Error(j.error || 'gagal')
    return j
}

async function main() {
    const argv = arg()
    const j = await api(argv[0])
    const presets = j.presets || []

    if (argv[1] === 'presets') {
        if (!presets.length) return console.log('[]')
        console.log(JSON.stringify(presets.map(p => p.url), null, 2))
        return
    }
    if (argv[1] === 'open') {
        const { execSync } = await import('node:child_process')
        for (const p of presets) {
            if (p.url) execSync(`xdg-open "${p.url}"`, { stdio: 'ignore' })
        }
        console.error(`dibuka ${presets.length} preset`)
        return
    }

    const v = j.video || {}
    console.log(JSON.stringify({
        ok: j.ok,
        videoId: j.videoId,
        title: v.description || null,
        videoSrc: v.src || null,
        videoSrcFrom: v.srcFrom || null,
        author: j.author ? { username: j.author.uniqueId, name: j.author.nickname } : null,
        stats: v.createTime ? {
            createTime: new Date(Number(v.createTime) * 1000).toISOString().slice(0, 10),
            views: v.views, likes: v.likes, comments: v.comments, shares: v.shares,
        } : null,
        scanned: j.scanned || null,
        presetCount: presets.length,
        presets,
    }, null, 2))
}

main().catch(e => { console.error(`Error: ${e.message}`); process.exit(1) })
