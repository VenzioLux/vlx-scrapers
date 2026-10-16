#!/usr/bin/env node
/*
Base : https://tv12.lk21official.cc + fallback mirrors
Author : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- LK21 streaming: home, section, search, info, streams, download
- Multi-base URL, auto fallback mirror
- Base bisa override: --base <url> / env LK21_BASE
- Fetch SSR HTML only, no login, no cookie, no browser
- Info detail lengkap + semua server stream
- Stream resolve: videonode.de/api.php -> player final
- Download mode: file video super cepat + bypass blokir IP
  -> chain p2p/playcdn: videonode api.php -> playcdn/verify -> m3u8 -> segmen
  -> bypass: playlist rotate ~40 domain duck.*.xyz (banyak mati 403),
     auto pilih domain yang hidup + unduh paralel + fallback per-segmen
  -> output .mp4 (remux ffmpeg -c copy kalau ada; fallback .ts tanpa ffmpeg)
- Search via mirror tv.nontonfilm.red, URL rewrite ke BASE
- Home pagination: /loadmore-home/page/N
- Output JSON, zero null (field kosong di-omit), zero dependency Node >=18
- Error JSON seragam: ok:false + kind + hint di stdout (exit 1)
- kind: bad_input | not_found | ip_blocked | service_down | network | parse_changed

Usage:
  node lk21P2p.mjs <url>|slug             info (default) — detail super lengkap + streams
  node lk21P2p.mjs <url>|slug info        sama, eksplisit
  node lk21P2p.mjs <url>|slug streams     cuma daftar URL streaming (embed + player final)
  node lk21P2p.mjs <url>|slug download [out]  unduh video (default <slug>.mp4; fallback .ts kalau gak ada ffmpeg)
  node lk21P2p.mjs home                   semua item unik halaman depan (field lengkap)
  node lk21P2p.mjs home <page>            halaman berikutnya (2,3,...) via loadmore
  node lk21P2p.mjs section <tipe> [page]  section khusus: latest-movies, latest-series,
                                       latest-action, latest-comedy, latest-horror,
                                       latest-korea, latest-india, latest-romance,
                                       latest-thailand
  node lk21P2p.mjs search "<keyword>"     cari film/series (via mirror, hasil di-rewrite)
  node lk21P2p.mjs --base <mirror> home   pakai base URL tertentu

Contoh:
  node lk21P2p.mjs https://tv12.lk21official.cc/spider-man-brand-new-day-2026
  node lk21P2p.mjs spider-man-brand-new-day-2026 info
  node lk21P2p.mjs spider-man-brand-new-day-2026 streams
  node lk21P2p.mjs home
  node lk21P2p.mjs section latest-korea 2
  node lk21P2p.mjs search "spider man"
  node lk21P2p.mjs --base https://tv.nontonfilm.red home
*/

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const WM = 'VenzioLûx — Vloûte Cataclysm'

//ffmpeg opsional: dipakai buat remux (Gak ada = fallback .ts)
const FFMPEG = (() => {
  const bin = process.env.LK21_FFMPEG || 'ffmpeg'
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' })
    return bin
  } catch {
    return null
  }
})()
const BASE_CANDIDATES = [
  'https://tv12.lk21official.cc',
  'https://tv.nontonfilm.red',
]

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const HDR = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8',
}

let BASE = process.env.LK21_BASE || ''

// parse CLI --base flag
const argvRaw = process.argv.slice(2)
let BASE_FLAG = false
const baseIdx = argvRaw.indexOf('--base')
if (baseIdx !== -1 && argvRaw[baseIdx + 1]) {
  BASE = argvRaw[baseIdx + 1]
  BASE_FLAG = true
  argvRaw.splice(baseIdx, 2)
}
if (!BASE) BASE = BASE_CANDIDATES[0]

class ServiceDown extends Error {
  constructor(m) { super(m); this.down = true }
}
class Blocked extends Error {
  constructor(m) { super(m); this.blocked = true }
}

const blocked = (where, status) => {
  if (status >= 520 && status <= 527) {
    const e = new ServiceDown(`${where} upstream error ${status} origin unreachable`)
    e.kind = 'service_down'
    throw e
  }
  if (status === 429) {
    const e = new Blocked(`${where} 429 too many requests rate limited`)
    e.kind = 'ip_blocked'
    throw e
  }
  if (status === 403) {
    const e = new Blocked(`${where} 403 forbidden cloudflare challenge`)
    e.kind = 'ip_blocked'
    throw e
  }
  if (status === 404) {
    const e = new Error(`${where} 404 not found`)
    e.kind = 'not_found'
    throw e
  }
  if (status >= 500) {
    const e = new ServiceDown(`${where} ${status} internal server error`)
    e.kind = 'service_down'
    throw e
  }
  const e = new Error(`${where} ${status} unexpected response check parser`)
  e.kind = 'unknown'
  throw e
}

const cfPage = (html) => /just a moment|attention required|cf-challenge/i.test(html)

// fetch (redirect auto)
const hit = async (url, opt = {}) => {
  const u = new URL(url)
  const t0 = performance.now()
  let r
  try {
    r = await fetch(u, {
      redirect: 'follow',
      ...opt,
      headers: { 'user-agent': UA, ...(opt.headers || {}) },
    })
  } catch (e) {
    const why = (e && e.cause && (e.cause.code || e.cause.message)) || e.message || 'unknown'
    const err = new Error(`${url} fetch failed ${why} connection reset`)
    err.kind = 'network'
    throw err
  }
  const body = await r.text()
  return { r, body, url: r.url, ms: performance.now() - t0 }
}

const resolveBase = async () => {
  if (process.env.LK21_BASE || BASE_FLAG) return BASE
  for (const candidate of BASE_CANDIDATES) {
    try {
      const r = await hit(candidate, { headers: HDR })
      if (r.r.status === 200 && !cfPage(r.body)) {
        BASE = candidate
        return candidate
      }
    } catch {}
  }
  return BASE_CANDIDATES[0]
}

//bersihkan teks dari HTML
const strip = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ').trim()

const compact = (o) => {
  const r = {}
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (v === null || v === undefined || v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    r[k] = v
  }
  return r
}

//ambil nilai atribut dari string tag
const attrVal = (tag, name) => {
  const m = String(tag || '').match(new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']', 'i'))
  return m ? m[1] : ''
}

const metaMap = (html) => {
  const out = {}
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const k = (attrVal(m[0], 'property') || attrVal(m[0], 'name') || '').toLowerCase()
    if (k && out[k] === undefined) out[k] = attrVal(m[0], 'content')
  }
  return out
}

//regex helper
const first = (html, re) => {
  const m = String(html).match(re)
  return m ? (m[1] !== undefined ? m[1] : m[0]) : ''
}

const each = (html, re) => {
  const out = []
  for (const m of String(html).matchAll(re)) out.push(m[1] !== undefined ? m[1] : m[0])
  return out
}

//script JSON inline by id
const jsonById = (html, id) => {
  const m = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/script>`, 'i'))
  if (!m) return null
  try { return JSON.parse(m[1].trim()) } catch { return null }
}

const jsonLdMovie = (html) => {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim())
      if (j && j['@type'] === 'Movie') return j
    } catch {}
  }
  return null
}

const row = (html, label) => {
  const m = String(html).match(new RegExp(`<p>\\s*<span>[^<]*${label}[^<]*</span>([\\s\\S]*?)</p>`, 'i'))
  return m ? strip(m[1]).replace(/\s*,\s*/g, ', ') : ''
}

const toUrl = (raw) => {
  const s = String(raw || '').trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  return `${BASE}/${s.replace(/^\/+/, '')}`
}

//resolve embed videonode
const resolveEmbed = async (url) => {
  const m = String(url).match(/videonode\.de\/iframe3\/([a-z0-9]+)\/([\w-]+)/i)
  if (!m) return null
  try {
    const r = await hit('https://videonode.de/api.php', {
      method: 'POST',
      headers: {
        ...HDR,
        'content-type': 'application/x-www-form-urlencoded',
        referer: url,
        'x-requested-with': 'XMLHttpRequest',
      },
      body: `host=${m[1]}&id=${m[2]}`,
    })
    if (r.r.status !== 200) return null
    const j = JSON.parse(r.body)
    return j && j.embedUrl ? j.embedUrl : null
  } catch { return null }
}

const parseCard = (block) => {
  //url/slug
  const aTag = first(block, /<a[^>]*itemprop="url"[^>]*>/i)
  let href = aTag ? attrVal(aTag, 'href') : ''
  if (!href) {
    const m = block.match(/<a[^>]+href="\/([a-z0-9][a-z0-9-]*[a-z0-9])"/i)
    href = m ? `/${m[1]}` : ''
  }
  if (!href) return null
  const slug = href.replace(/^\/+|\/+$/g, '').split('/')[0]
  if (!slug) return null

  const title = strip(first(block, /<h3[^>]*class="[^"]*poster-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i))
    || strip(first(block, /<h2[^>]*class="[^"]*entry-title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i))
    || strip(first(block, /<img[^>]+alt="([^"]*)"/i))
  if (!title) return null

  let thumb = ''
  const imgTag = first(block, /<img[^>]*itemprop="image"[^>]*>/i) || first(block, /<img[^>]+>/i)
  if (imgTag) {
    thumb = attrVal(imgTag, 'data-src') || attrVal(imgTag, 'src') || ''
    if (!/^https?:/i.test(thumb)) thumb = ''
  }
  if (!thumb) thumb = first(block, /<source[^>]+type="image\/jpeg"[^>]+(?:data-)?srcset="([^"\s]+)"/i)
  thumb = thumb.replace(/-\d+x\d+(\.(?:jpe?g|png|webp))$/i, '$1')

  const kategori = attrVal(first(block, /<meta[^>]*itemprop="genre"[^>]*>/i) || '<meta>', 'content')
    || strip(first(block, /<div class="genre"[^>]*>([\s\S]*?)<\/div>/i))
    || each(first(block, /<div class="gmr-movie-on"[^>]*>([\s\S]*?)<\/div>/i), /<a[^>]*>([\s\S]*?)<\/a>/gi).map(strip).filter(Boolean).join(', ')
  const rating = strip(first(block, /itemprop="ratingValue"[^>]*>([\s\S]*?)<\/span>/i))
    || strip(first(block, /<span class="rating"[^>]*>([\s\S]*?)<\/span>/i))
    || strip(first(block, /class="gmr-rating-item"[^>]*>([\s\S]*?)<\/div>/i))
  const ratingCount = attrVal(first(block, /<meta[^>]*itemprop="ratingCount"[^>]*>/i) || '<meta>', 'content')
  const year = strip(first(block, /class="year"[^>]*>([\s\S]*?)<\/span>/i))
    || first(title, /\b((?:19|20)\d{2})\b/)
  const quality = first(block, /class="label label-([A-Za-z0-9]+)/i)
    || strip(first(block, /class="gmr-quality-item[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i))
  const durasi = strip(first(block, /class="duration"[^>]*>([\s\S]*?)<\/span>/i))
    || strip(first(block, /class="gmr-duration-item"[^>]*>([\s\S]*?)<\/div>/i))
  const isSeries = /class="episode/.test(block)
  const episode = isSeries
    ? strip(first(block, /class="episode[^"]*"[^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>/i)) || null
    : null
  const season = /^S\.\d+/i.test(durasi) ? durasi.replace(/^S\./i, '') : null

  return compact({
    title,
    url: `${BASE}/${slug}`,
    slug,
    thumbnail: thumb || null,
    kategori: kategori || null,
    rating: rating || null,
    ratingCount: ratingCount || null,
    year: year || null,
    tipe: isSeries ? 'series' : 'film',
    episode,
    season,
    quality: quality || null,
    durasi: durasi || null,
  })
}

const parseCards = (html) => {
  const out = []
  const seen = new Set()
  for (const m of html.matchAll(/<article[\s\S]*?<\/article>/gi)) {
    const it = parseCard(m[0])
    if (!it || seen.has(it.slug)) continue
    seen.add(it.slug)
    out.push(it)
  }
  return out
}

const MIRROR = 'https://tv.nontonfilm.red'
async function search(q) {
  const T0 = performance.now()
  const src = `${MIRROR}/?s=${encodeURIComponent(q)}`
  const r = await hit(src, { headers: HDR })
  if (r.r.status !== 200) blocked(src, r.r.status)
  if (cfPage(r.body)) throw new Blocked(`${src} 403 forbidden cloudflare challenge`)

  const results = []
  const seen = new Set()
  for (const m of r.body.matchAll(/<article[\s\S]*?<\/article>/gi)) {
    const el = m[0]
    const uTag = first(el, /<a[^>]*itemprop="url"[^>]*>/i)
    let url = uTag ? attrVal(uTag, 'href') : ''
    if (!url) continue
    if (/nontonfilm\.red/i.test(url)) url = url.replace(/^https?:\/\/[^/]+/i, BASE).replace(/\/+$/, '')
    if (seen.has(url)) continue

    const title = strip(first(el, /<h2[^>]*class="[^"]*entry-title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i))
      || strip(first(el, /title="Permalink to:\s*([^"]+)"/i))
    if (!title) continue
    seen.add(url)

    let thumb = ''
    const imgTag = first(el, /<img[^>]*wp-post-image[^>]*>/i) || first(el, /<img[^>]+>/i)
    if (imgTag) {
      thumb = attrVal(imgTag, 'data-src') || attrVal(imgTag, 'src') || ''
      thumb = thumb.replace(/-\d+x\d+(\.(?:jpe?g|png|webp))$/i, '$1')
    }
    const rating = strip(first(el, /class="gmr-rating-item"[^>]*>([\s\S]*?)<\/div>/i))
    const durasi = strip(first(el, /class="gmr-duration-item"[^>]*>([\s\S]*?)<\/div>/i))
    const quality = strip(first(el, /class="gmr-quality-item[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i))
    const genreSeg = first(el, /<div class="gmr-movie-on"[^>]*>([\s\S]*?)<\/div>/i)
    const kategori = each(genreSeg, /<a[^>]*>([\s\S]*?)<\/a>/gi).map(strip).filter(Boolean).join(', ')
    const year = first(title, /\b((?:19|20)\d{2})\b/)
    results.push(compact({
      title,
      url,
      thumbnail: thumb || null,
      kategori: kategori || null,
      rating: rating || null,
      durasi: durasi || null,
      quality: quality || null,
      year: year || null,
    }))
  }

  if (!results.length) {
    const e = new Error(`search "${q}" no results keyword gak ketemu atau parser changed`)
    e.kind = 'not_found'
    throw e
  }
  return {
    input: q,
    mode: 'search',
    ok: true,
    base: BASE,
    via: 'tv.nontonfilm.red',
    results,
    count: results.length,
    engine: 'lk21.direct',
    watermark: WM,
    source: `LK21 (${BASE})`,
    elapsedMs: Math.round(performance.now() - T0),
  }
}

async function home(arg = 1) {
  const T0 = performance.now()
  const pg = Math.max(1, Math.floor(Number(arg) || 1))
  let src = pg > 1 ? `${BASE}/loadmore-home/page/${pg}` : `${BASE}/`
  let r = await hit(src, { headers: HDR })
  if (pg > 1 && (r.r.status !== 200 || !r.body.trim())) {
    src = `${BASE}/release/page/${pg}`
    r = await hit(src, { headers: HDR })
  }
  if (r.r.status !== 200) blocked(src, r.r.status)
  if (cfPage(r.body)) throw new Blocked(`${src} 403 forbidden cloudflare challenge`)

  const results = parseCards(r.body)
  if (!results.length) {
    const e = new Error(`${src} empty results ${pg > 1 ? 'no more pages end of list' : 'parser may have changed'}`)
    e.kind = pg > 1 ? 'not_found' : 'parse_changed'
    throw e
  }
  return {
    input: BASE,
    mode: 'home',
    page: pg,
    ok: true,
    base: BASE,
    results,
    count: results.length,
    engine: 'lk21.direct',
    watermark: WM,
    source: `LK21 (${BASE})`,
    elapsedMs: Math.round(performance.now() - T0),
  }
}

async function section(type, page = 1) {
  const T0 = performance.now()
  const t = String(type || '').trim()
  if (!t) {
    const e = new Error(`section missing type expected latest-movies latest-series etc`)
    e.kind = 'bad_input'
    throw e
  }
  const pg = Math.max(1, Math.floor(Number(page) || 1))
  const src = `${BASE}/loadmore/${encodeURIComponent(t)}/page/${pg}`
  const r = await hit(src, { headers: HDR })
  if (r.r.status !== 200) blocked(src, r.r.status)
  if (cfPage(r.body)) throw new Blocked(`${src} 403 forbidden cloudflare challenge`)

  const results = []
  const seen = new Set()
  for (const m of r.body.matchAll(/<li class="slider"[\s\S]*?<\/li>/gi)) {
    const it = parseCard(m[0])
    if (it && !seen.has(it.slug)) {
      seen.add(it.slug)
      results.push(it)
    }
  }
  if (!results.length) results.push(...parseCards(r.body))
  if (!results.length) {
    const e = new Error(`${src} empty results parser may have changed`)
    e.kind = 'parse_changed'
    throw e
  }

  return {
    input: t,
    mode: 'section',
    page: pg,
    ok: true,
    base: BASE,
    results,
    count: results.length,
    engine: 'lk21.direct',
    watermark: WM,
    source: `LK21 (${BASE})`,
    elapsedMs: Math.round(performance.now() - T0),
  }
}

async function detail(link) {
  const T0 = performance.now()
  const r = await hit(link, { headers: HDR })
  if (r.r.status !== 200) blocked(link, r.r.status)
  const html = r.body
  if (cfPage(html)) throw new Blocked(`${link} 403 forbidden cloudflare challenge`)
  const M = metaMap(html)
  const LD = jsonLdMovie(html)
  const WHD = jsonById(html, 'watch-history-data')
  const title = strip(first(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i))
    || strip(WHD && WHD.title ? `${WHD.title} (${WHD.year})` : '')
    || strip(M['og:title'] || '')
  if (!title) {
    const now = first(html, /<a[^>]+href="(https?:\/\/[^"]+)"[^>]+id="openNow"/i)
      || first(html, /<a[^>]+id="openNow"[^>]+href="(https?:\/\/[^"]+)"/i)
    if (now) {
      return compact({
        input: link, mode: 'info', ok: false, base: BASE,
        kind: 'redirect', redirect: now,
        hint: HINT.redirect,
        engine: 'lk21.direct', watermark: WM, source: `LK21 (${BASE})`,
        elapsedMs: Math.round(performance.now() - T0),
      })
    }
    const e = new Error(`${link} unexpected response empty title parser may have changed`)
    e.kind = 'parse_changed'
    throw e
  }

  const desc = strip(first(html, /<div class="synopsis[^"]*"[^>]*>([\s\S]*?)<\/div>/i))
    || strip(M['og:description'] || '')
    || strip(M['description'] || '')
    || strip(LD && LD.description || '')
  const cover = M['og:image'] || (WHD && WHD.poster) || M['twitter:image']
    || (LD && String(LD.image || ''))
    || attrVal(first(html, /<img[^>]*itemprop="image"[^>]*>/i) || '<img>', 'data-src')
    || ''

  const chipIdx = html.indexOf('<div class="info-tag">')
  const chips = chipIdx !== -1
    ? each(html.slice(chipIdx, chipIdx + 400), /<span>([^<]*)<\/span>/gi).map(strip).filter(Boolean)
    : []
  const duration = chips.find((c) => /^\d+\s*h/i.test(c))
    || String(WHD && WHD.runtime || '')
    || strip(first(html, /<span class="duration"[^>]*>([^<]*)</i))
  const quality = chips.find((c) => /^(WEB|BLU|HD|CAM|DVD|TS|BDR|BRR|SD|4K)/i.test(c)) || null
  const resolution = chips.find((c) => /^(\d{3,4}p|4K|8K)$/i.test(c)) || null
  const ageRating = chips.find((c) => /\+$/i.test(c) || /^(SU|R-G|R|PG-13|PG|G|TV-)/i.test(c)) || null

  const rating = strip(first(html, /class="rating-number"[^>]*>([\d.]+)</i))
    || String(WHD && WHD.rating || '')
    || strip(LD && LD.aggregateRating && LD.aggregateRating.ratingValue || '')
    || strip(first(html, /itemprop="ratingValue"[^>]*>([\s\S]*?)<\/span>/i))
  const votes = first(html, /data-base-votes="(\d+)"/i)
    || String((LD && LD.aggregateRating && LD.aggregateRating.ratingCount) || '')
    || first(html, /itemprop="ratingCount">(\d+)</i)
    || row(html, 'Votes').replace(/[^\d]/g, '')

  const director = row(html, 'Sutradara')
  const castTxt = row(html, 'Bintang Film')
  const subtitle = row(html, 'Subtitle')
  const release = row(html, 'Release')
  const updated = row(html, 'Updated')

  const tagSeg = first(html, /<div class="tag-list">([\s\S]*?)<\/div>/i)
  const genres = each(tagSeg, /<a[^>]*href="\/genre\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi).map(strip).filter(Boolean)
  const countries = each(tagSeg, /<a[^>]*href="\/country\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi).map(strip).filter(Boolean)
  const kategoriArr = (genres.length ? genres : [].concat((LD && LD.genre) || [])).filter(Boolean)
  const cast = castTxt ? castTxt.split(',').map((s) => s.trim()).filter(Boolean) : []
  const negaraTx = row(html, 'Negara')
  const country = countries.length ? countries : (negaraTx ? negaraTx.split(',').map((s) => s.trim()).filter(Boolean) : [])

  const year = String((WHD && WHD.year) || '')
    || first(html, /<span class="year"[^>]*>(\d{4})</i)
    || (LD && LD.datePublished ? String(LD.datePublished).slice(0, 4) : '')
    || first(title, /\((\d{4})\)/)

  const trailer = first(html, /href="(https?:\/\/www\.youtube\.com\/watch\?[^"]+)"/i) || null
  const download = first(html, /<a[^>]+href="(https?:\/\/[^"]+)"[^>]+title="Download[^"]*"/i) || null
  const tipe = /series/i.test(first(html, /data-related_type="([^"]+)"/i)) ? 'series' : 'film'
  const titleSeo = strip(M['og:title'] || '')
  const descriptionSeo = strip(M['og:description'] || M['twitter:description'] || '')
  const siteName = strip(M['og:site_name'] || '')
  const contentType = strip(M['og:type'] || '')
  const ratingScale = (() => {
    const v = LD && LD.aggregateRating && LD.aggregateRating.bestRating != null
      ? Number(LD.aggregateRating.bestRating) : NaN
    return Number.isFinite(v) ? v : null
  })()
  const durationMinutes = (() => {
    const d = String(duration || '').trim()
    const h = d.match(/^(\d+)\s*h(?:\s*(\d+)\s*m)?/i)
    if (h) return Number(h[1]) * 60 + (h[2] ? Number(h[2]) : 0)
    const hm = d.match(/^(\d{1,2}):(\d{2})$/)
    if (hm) return Number(hm[1]) * 60 + Number(hm[2])
    return null
  })()
  const awards = strip(((desc || '').match(/\bAwards?:\s*(.+?)\s*(?=Budget:|Worldwide Gross:|Soundtrack:|$)/i) || [])[1] || '')
  const budget = strip(((desc || '').match(/\bBudget:\s*(.+?)\s*(?=Awards?:|Worldwide Gross:|Soundtrack:|$)/i) || [])[1] || '')
  const gross = strip(((desc || '').match(/\bWorldwide Gross:\s*(.+?)\s*(?=Awards?:|Budget:|Soundtrack:|$)/i) || [])[1] || '')
  const soundtrack = strip(((desc || '').match(/\bSoundtrack:\s*(.+?)\s*$/i) || [])[1] || '')
  const related = (() => {
    const i = html.indexOf('class="related-content"')
    if (i === -1) return []
    const seg0 = html.slice(i)
    const u = seg0.indexOf('</ul>')
    const seg = seg0.slice(0, u === -1 ? 8000 : u + 5)
    const out = []
    const seenR = new Set()
    for (const m of seg.matchAll(/<a\b[^>]*\shref="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi)) {
      const href = m[1]
      if (!/^(\/|https?:)/i.test(href)) continue
      const block = m[0]
      const rt = strip(first(block, /<span class="video-title">([\s\S]*?)<\/span>/i))
        || strip(first(block, /<img[^>]+alt="([^"]*)"/i))
      if (!rt) continue
      const key = href.toLowerCase()
      if (seenR.has(key)) continue
      seenR.add(key)
      const ry = strip(first(block, /<span class="video-year">([\s\S]*?)<\/span>/i))
      const imgTag = first(block, /<img[^>]+>/i)
      let rth = imgTag ? (attrVal(imgTag, 'data-src') || attrVal(imgTag, 'src')) : ''
      if (!/^https?:/i.test(rth)) rth = ''
      rth = rth.replace(/-\d+x\d+(\.(?:jpe?g|png|webp))$/i, '$1')
      out.push(compact({
        title: rt,
        year: ry || null,
        url: /^https?:/i.test(href) ? href : `${BASE}/${href.replace(/^\/+/, '')}`,
        thumbnail: rth || null,
      }))
    }
    return out.slice(0, 20)
  })()
  const slug = (WHD && WHD.slug) || (() => {
    try { return new URL(link).pathname.replace(/^\/+|\/+$/g, '') } catch { return '' }
  })()
  const id = (WHD && WHD.id) || first(html, /data-post_id="(\d+)"/i) || null
  const streams = []
  const seen = new Set()
  const addStream = (label, url) => {
    const clean = String(url || '').trim()
    if (!clean || /^#|^javascript:/i.test(clean)) return
    if (/googletagmanager|facebook|analytics|doubleclick|youtube|cloudflare/i.test(clean)) return
    const key = clean.split('?')[0].toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    streams.push({ server: label, url: clean })
  }
  for (const m of html.matchAll(/<iframe[^>]*src=["']([^"']+)["']/gi)) addStream('Player', m[1])
  for (const m of html.matchAll(/<a[^>]+data-url=["']([^"']+)["'][^>]*data-server=["']([^"']*)["']/gi)) addStream((m[2] || 'stream').toUpperCase(), m[1])
  for (const m of html.matchAll(/<option[^>]+value=["']([^"']+)["'][^>]*data-server=["']([^"']*)["']/gi)) addStream((m[2] || 'stream').toUpperCase(), m[1])
  if (!streams.length) {
    for (const m of html.matchAll(/(?:href|src)=["'](https?:\/\/[^"']+)["']/gi)) {
      if (/embed|\/e\/|player|m3u8|\.mp4|stream/i.test(m[1])) addStream('Stream', m[1])
    }
  }
  
  await Promise.all(streams.map(async (s) => {
    const p = await resolveEmbed(s.url)
    if (p) s.player = p
  }))
  return compact({
    input: link,
    mode: 'info',
    ok: true,
    base: BASE,
    title,
    titleSeo,
    description: desc,
    descriptionSeo,
    siteName,
    contentType,
    thumbnail: cover,
    duration: duration || null,
    durationMinutes,
    rating: rating || null,
    ratingScale,
    kategori: kategoriArr.join(', ') || null,
    url: link,
    id,
    slug,
    tipe,
    quality,
    resolution,
    ageRating,
    year: year || null,
    release: release || null,
    updated: updated || null,
    votes: votes || null,
    genres: kategoriArr,
    country,
    director: director || null,
    cast,
    subtitle: subtitle || null,
    trailer,
    download,
    awards,
    budget,
    gross,
    soundtrack,
    related,
    streamCount: streams.length,
    streams,
    engine: 'lk21.direct',
    watermark: WM,
    source: `LK21 (${BASE})`,
    elapsedMs: Math.round(performance.now() - T0),
  })
}

const SEG_HDR = {
  'user-agent': UA,
  accept: 'image/avif,image/webp,*/*',
  'accept-language': 'id-ID,id;q=0.9,en;q=0.8',
  referer: 'https://playcdn.de/',
}
const CONC_PER_HOST = 3
const MAX_CONC = 12
const downloadHls = async (segs, hosts, out) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lk21-'))
  let next = 0
  const take = () => (next < segs.length ? next++ : -1)
  const worker = async () => {
    for (;;) {
      const i = take()
      if (i < 0) return
      const s = segs[i]
      const order = hosts.map((_, k) => hosts[(i + k) % hosts.length])
      let buf = null
      let last = ''
      for (const h of order) {
        try {
          const r = await fetch(`https://${h}${s.path}`, { headers: SEG_HDR, signal: AbortSignal.timeout(60000) })
          if (!r.ok) { last = `${h} ${r.status}`; continue }
          const b = Buffer.from(await r.arrayBuffer())
          if (!b.length || b.slice(0, 5).toString('latin1').toLowerCase().startsWith('<!doc')) { last = `${h} html`; continue }
          buf = b
          break
        } catch (e) { last = e.message }
      }
      if (!buf) throw new Error(`segment ${s.name} failed ${last || 'all hosts rejected'}`)
      fs.writeFileSync(path.join(tmp, `${s.name}.part`), buf)
    }
  }
  try {
    const want = Math.min(Math.max(hosts.length * CONC_PER_HOST, CONC_PER_HOST), MAX_CONC)
    await Promise.all(Array.from({ length: Math.min(want, segs.length) }, worker))
    const fd = fs.openSync(out, 'w')
    let bytes = 0
    try {
      for (const s of segs) {
        const f = path.join(tmp, `${s.name}.part`)
        const b = fs.readFileSync(f)
        fs.writeSync(fd, b, 0, b.length, bytes)
        bytes += b.length
        fs.rmSync(f, { force: true })
      }
    } finally {
      fs.closeSync(fd)
    }
    return bytes
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const parseHls = (man) => {
  const segs = []
  const hosts = new Set()
  for (const raw of String(man).split('\n')) {
    const l = raw.trim()
    if (!l || l.startsWith('#')) continue
    let u
    try { u = new URL(l) } catch { continue }
    const m = u.pathname.match(/\/docs\/([^/]+)\/(\d+)\.pict$/i)
    if (!m) continue
    hosts.add(u.host)
    segs.push({ name: m[2], path: u.pathname })
  }
  return { segs, hosts: [...hosts] }
}

const probeHost = async (host, segPath) => {
  try {
    const r = await fetch(`https://${host}${segPath}`, {
      headers: { ...SEG_HDR, range: 'bytes=0-1023' },
      signal: AbortSignal.timeout(15000),
    })
    const ct = (r.headers.get('content-type') || '').toLowerCase()
    const ok = (r.status === 200 || r.status === 206) && !ct.includes('html')
    try { await r.body?.cancel?.() } catch {}
    return ok
  } catch { return false }
}

const pickHosts = async (hosts, segPath, want = 3) => {
  const live = []
  const batch = []
  for (const h of hosts) {
    if (live.length >= want) break
    batch.push(
      probeHost(h, segPath).then((ok) => { if (ok && live.length < want) live.push(h) }).catch(() => {}),
    )
    if (batch.length >= 8) { await Promise.all(batch); batch.length = 0 }
  }
  await Promise.all(batch)
  return live
}

const resolvePlaycdn = async (iframeUrl) => {
  const m = String(iframeUrl).match(/videonode\.de\/iframe3\/([a-z0-9]+)\/([\w-]+)/i)
  if (!m || m[1].toLowerCase() !== 'p2p') return null
  const player = await resolveEmbed(iframeUrl)
  if (!player) return null
  let slug
  try { slug = new URL(player).pathname.replace(/^\/+|\/+$/g, '') } catch { return null }
  if (!slug) return null
  const v = await hit(`https://playcdn.de/verify/${slug}`, { headers: { ...HDR, accept: 'application/json,*/*', referer: player } })
  if (v.r.status !== 200) {
    const e = new Error(`playcdn verify ${v.r.status} server rejected`)
    e.kind = v.r.status === 403 || v.r.status === 429 ? 'ip_blocked' : 'service_down'
    throw e
  }
  let j
  try { j = JSON.parse(v.body) } catch { j = null }
  if (!j || !j.fileUrl) {
    const e = new Error(`playcdn verify missing fileUrl parser changed`)
    e.kind = 'parse_changed'
    throw e
  }
  return { host: 'p2p', id: m[2], player, slug, fileUrl: j.fileUrl, title: j.title, poster: j.poster }
}

const remuxMp4 = (from, to) => {
  const mov = /\.(mp4|mov|m4v)$/i.test(to) ? ['-movflags', '+faststart'] : []
  const run = (bsf) =>
    spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', from, '-c', 'copy', ...bsf, ...mov, to], {
      stdio: ['ignore', 'ignore', 'pipe'],
    }).status === 0
  return run(['-bsf:a', 'aac_adtstoasc']) || run([])
}

async function download(link, outArg) {
  const T0 = performance.now()
  const r = await detail(link)
  if (r.ok === false) return r // redirect
  const streams = r.streams || []
  const p2p = streams.find((s) => /videonode\.de\/iframe3\/p2p\//i.test(s.url))
  if (!p2p) {
    const e = new Error(`${link} server p2p playcdn not available ${streams.length} other servers found`)
    e.kind = 'not_found'
    throw e
  }
  const stream = await resolvePlaycdn(p2p.url)
  if (!stream) {
    const e = new Error(`${link} resolve playcdn failed embed not returned`)
    e.kind = 'parse_changed'
    throw e
  }
  const man = await hit(stream.fileUrl, { headers: { ...HDR, accept: 'application/vnd.apple.mpegurl,*/*', referer: stream.player } })
  if (man.r.status !== 200) {
    const e = new Error(`m3u8 ${man.r.status} playlist fetch failed`)
    e.kind = man.r.status === 403 || man.r.status === 429 ? 'ip_blocked' : 'service_down'
    throw e
  }
  const { segs, hosts } = parseHls(man.body)
  if (!segs.length) {
    const e = new Error(`playlist empty no segments parser may have changed`)
    e.kind = 'parse_changed'
    throw e
  }
  const live = await pickHosts(hosts, segs[0].path, 3)
  if (!live.length) {
    const e = new Blocked(`${hosts.length} domain duck.*.xyz all rejected 403 cloudflare challenge`)
    e.kind = 'ip_blocked'
    throw e
  }
  const wantMp4 = !!FFMPEG && !/\.ts$/i.test(outArg || '')
  let out = outArg || r.slug || 'lk21'
  if (!/\.[a-z0-9]+$/i.test(out)) out += `.${wantMp4 ? 'mp4' : 'ts'}`
  const stem = out.replace(/\.[a-z0-9]+$/i, '')
  const tDl = performance.now()
  const raw = wantMp4 ? `${stem}.tmp.ts` : out
  let bytes = await downloadHls(segs, live, raw)
  let remuxed = false
  let file = out
  if (wantMp4) {
    remuxed = remuxMp4(raw, out)
    if (remuxed) {
      bytes = fs.statSync(out).size
      fs.rmSync(raw, { force: true })
    } else {
      file = `${stem}.ts`
      fs.renameSync(raw, file)
      fs.rmSync(out, { force: true })
    }
  }
  return compact({
    input: link,
    mode: 'download',
    ok: true,
    base: BASE,
    title: r.title,
    id: r.id,
    slug: r.slug,
    tipe: r.tipe,
    year: r.year,
    quality: r.quality,
    resolution: r.resolution,
    duration: r.duration,
    poster: r.thumbnail,
    server: 'p2p',
    provider: 'playcdn',
    player: stream.player,
    stream: stream.fileUrl,
    segments: segs.length,
    hostsTotal: hosts.length,
    hostsLive: live.length,
    host: live[0],
    bytes,
    size: { bytes, mb: +((bytes / 1048576).toFixed(2)) },
    file: path.resolve(file),
    container: path.extname(file).slice(1),
    remuxed,
    downloadMs: Math.round(performance.now() - tDl),
    speedMbps: bytes ? +((bytes * 8) / ((performance.now() - tDl) / 1000) / 1e6).toFixed(2) : null,
    engine: 'lk21.direct',
    watermark: WM,
    source: `LK21 (${BASE})`,
    note: !FFMPEG
      ? 'ffmpeg not in PATH — output .ts. Install ffmpeg to auto convert to .mp4.'
      : wantMp4 && !remuxed
        ? 'remux to mp4 failed — file saved as .ts'
        : null,
    elapsedMs: Math.round(performance.now() - T0),
  })
}

const HINT = {
  bad_input: 'invalid usage expected home | section <type> [page] | search "<kw>" | <url> [info|streams|download]',
  not_found: 'not found check slug url keyword may be removed or no results',
  ip_blocked: 'ip blocked or rate limited wait retry or switch --base mirror',
  service_down: 'origin down 52x target unreachable retry later',
  network: 'network error check connection dns reset',
  parse_changed: 'parser changed site structure updated report for fix',
  redirect: 'redirect detected open redirect field',
  unknown: 'unknown error check message parser may have changed',
}

const errOut = (input, mode, e, T0) => {
  const kind = e.down ? 'service_down' : e.blocked ? 'ip_blocked' : (e.kind || 'unknown')
  return compact({
    input: input || null,
    mode,
    ok: false,
    base: BASE,
    kind,
    error: e.message,
    hint: HINT[kind] || null,
    engine: 'lk21.direct',
    watermark: WM,
    source: `LK21 (${BASE})`,
    elapsedMs: Math.round(performance.now() - T0),
  })
}

function help() {
  const t = fs.readFileSync(process.argv[1], 'utf8')
  const m = t.match(/Usage:\n([\s\S]*?)\n\*\//)
  console.log(m ? m[1].replace(/^ {2}/gm, '') : 'node lk21P2p.mjs <url> [info|streams|download] | home [page] | section <tipe> [page] | search "<keyword>"')
}

async function main() {
  const T0 = performance.now()
  const argv = argvRaw
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    help()
    process.exitCode = argv.length ? 0 : 1
    return
  }

  let mode = argv[0]
  let input = argv.join(' ')
  try {
    if (!process.env.LK21_BASE && !BASE_FLAG) {
      await resolveBase()
    }

    if (argv[0] === 'home') {
      console.log(JSON.stringify(await home(argv[1] || 1), null, 2))
      return
    }
    if (argv[0] === 'section') {
      if (!argv[1]) {
        const e = new Error(`section missing type expected latest-movies latest-series etc`)
        e.kind = 'bad_input'
        throw e
      }
      console.log(JSON.stringify(await section(argv[1], argv[2] || 1), null, 2))
      return
    }
    if (argv[0] === 'search') {
      const q = argv.slice(1).join(' ')
      if (!q) {
        const e = new Error(`search missing query expected keyword`)
        e.kind = 'bad_input'
        throw e
      }
      console.log(JSON.stringify(await search(q), null, 2))
      return
    }

    mode = (argv[1] || 'info').toLowerCase()
    if (!['info', 'streams', 'download'].includes(mode)) {
      const e = new Error(`invalid mode ${mode} expected info, streams or download`)
      e.kind = 'bad_input'
      throw e
    }
    const link = toUrl(argv[0])
    if (!link) {
      const e = new Error(`invalid input expected url or slug`)
      e.kind = 'bad_input'
      throw e
    }
    input = link
    if (mode === 'download') {
      const outArg = argv.slice(2).find((x) => /[./]/.test(x))
      console.log(JSON.stringify(await download(link, outArg), null, 2))
      return
    }
    const r = await detail(link)
    if (mode === 'streams') {
      console.log(JSON.stringify(compact({
        input: r.input,
        mode: 'streams',
        ok: true,
        base: r.base,
        title: r.title,
        url: r.url,
        streams: r.streams,
        count: r.streamCount,
        streamCount: r.streamCount,
        engine: r.engine,
        source: r.source,
        watermark: r.watermark,
        elapsedMs: r.elapsedMs,
      }), null, 2))
    } else {
      console.log(JSON.stringify(r, null, 2))
    }
  } catch (e) {
    console.log(JSON.stringify(errOut(input, mode, e, T0), null, 2))
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(`fatal ${e.message}`)
  process.exitCode = 1
})
