#!/usr/bin/env node
/*
Base : https://x.com (GraphQL guest-token, tanpa login)
Author : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Tanpa login/cookie/API key/browser — cuma guest-token
- Auto cache 3 jam di /tmp, auto refresh kalau 401/403
- Video asli s/d 4K, foto, GIF->mp4, pilih resolusi (4k/2k/1080p/dst)
- Metadata lengkap: caption, author, stats, tanggal
- Mode profil: bio, follower, verified, avatar
- Download kenceng single-stream + resume
- Support username / URL tweet (bukan keyword search)
- Limit: cuma 40 tweet terbaru (batasan timeline publik X)

Usage:
  node xGst.mjs <username> 40 tweet terbaru ber-media + metadata
  node xGst.mjs <username> profile profil user (bio, follower, verified, avatar)
  node xGst.mjs <username> list [n] daftar tweet ber-media (paging ke n)
  node xGst.mjs <tweetUrl> metadata super lengkap (default)
  node xGst.mjs <tweetUrl> info sama, eksplisit
  node xGst.mjs <tweetUrl> best [out.mp4] variant bitrate tertinggi
  node xGst.mjs <tweetUrl> 4k [out.mp4] video 4K (2160p)
  node xGst.mjs <tweetUrl> 2k [out.mp4] video 2K (1440p)
  node xGst.mjs <tweetUrl> 1080p [out.mp4] video 1080p
  node xGst.mjs <tweetUrl> 720p [out.mp4] video 720p
  node xGst.mjs <tweetUrl> 480p [out.mp4] video 480p
  node xGst.mjs <tweetUrl> gif [out.mp4] GIF → mp4
  node xGst.mjs <tweetUrl> photo [dir] semua foto di tweet
  node xGst.mjs <id> <username> [mode] [out] ID polos, username dipisah

Contoh:
  node xGst.mjs NASA profile
  node xGst.mjs NASA list 20
  node xGst.mjs https://x.com/NASA/status/2108221043743793212 4k crew12.mp4
  node xGst.mjs 2108221043743793212 NASA best reentry.mp4
*/

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const ACTIVATE = 'https://api.twitter.com/1.1/guest/activate.json'
const GQL = 'https://twitter.com/i/api/graphql'
const QID_USER = 'pVrmNaXcxPjisIvKtLDMEA'
const QID_TWEETS = 'E3opETHurmVJflFsUBVuUQ'
const CACHE = path.join(os.tmpdir(), 'xGst-guest.json')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const HDR = {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    referer: 'https://x.com/',
}
const HDR_CDN = { 'user-agent': UA }
const WM = 'VenzioLûx — Vloûte Cataclysm'
const SRC = 'x.com (GraphQL guest-token)'
const QUALITIES = ['4k', '2k', '1080p', '720p', '480p']

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const enc = encodeURIComponent
const _size = (f) => { try { return fs.statSync(f).size } catch { return 0 } }

function help() {
    const t = fs.readFileSync(process.argv[1], 'utf8')
    const m = t.match(/Usage:\n([\s\S]*?)\n\*\//m)
    console.log(m ? m[1].replace(/^ {2}/gm, '') : 'node xGst.mjs <username|url> [mode] [out]')
    process.exit(process.argv.length > 2 ? 0 : 1)
}

//guest token
async function guest(force = false) {
    if (!force) {
        try {
            const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
            if (c.when > Date.now() - 7200e3 && c.token) return c.token
        } catch { }
    }
    const r = await fetch(ACTIVATE, { method: 'POST', headers: { authorization: `Bearer ${BEARER}`, ...HDR } })
    if (!r.ok) throw new Error(`guest token gagal (${r.status})`)
    const j = await r.json()
    fs.writeFileSync(CACHE, JSON.stringify({ token: j.guest_token, when: Date.now() }))
    return j.guest_token
}

const gql = async (qid, op, vars, feats, retry = true) => {
    const tok = await guest(!retry)
    let url = `${GQL}/${qid}/${op}?variables=${enc(JSON.stringify(vars))}`
    if (feats) url += `&features=${enc(JSON.stringify(feats))}`
    const r = await fetch(url, { headers: { authorization: `Bearer ${BEARER}`, 'x-guest-token': tok, ...HDR } })
    if ((r.status === 401 || r.status === 403) && retry) {
        fs.rmSync(CACHE, { force: true })
        return gql(qid, op, vars, feats, false)
    }
    if (r.status === 404) {
        const e = new Error(`queryId X udah dirotasi (${op} -> 404). QueryId operasi "${op}" perlu di-update di file ini.`)
        e.rotated = true
        throw e
    }
    if (!r.ok) throw new Error(`${op} balik ${r.status}`)
    return r.json()
}

const FEATS = {
    hidden_profile_subscriptions_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
}

//user
export const user = async (screenName) => {
    const j = await gql(QID_USER, 'UserByScreenName', { screen_name: screenName, withSafetyModeUserFields: true }, FEATS)
    const r = j?.data?.user?.result
    if (!r) throw new Error(`user @${screenName} nggak ketemu`)
    if (r.__typename === 'UserUnavailable') throw new Error(`user @${screenName} suspended/private`)
    const L = r.legacy || {}
    return {
        id: r.rest_id || '',
        name: L.name || '',
        username: L.screen_name || screenName,
        bio: L.description || '',
        location: L.location || '',
        verified: Boolean(r.is_blue_verified),
        followers: L.followers_count ?? null,
        following: L.friends_count ?? null,
        statuses: L.statuses_count ?? null,
        createdAt: L.created_at || null,
        avatar: L.profile_image_url_https || '',
        url: `https://x.com/${L.screen_name || screenName}`,
    }
}

//timeline -> tweet
export const timeline = async (screenName, { count = 40 } = {}) => {
    const u = await user(screenName)
    const j = await gql(QID_TWEETS, 'UserTweets', {
        userId: u.id,
        count,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: false,
        withVoice: false,
    }, FEATS)
    const out = []
    const walk = (o) => {
        if (!o || typeof o !== 'object') return
        if (Array.isArray(o)) { for (const v of o) walk(v); return }
        const L = o.legacy
        if (L && typeof L.full_text === 'string') {
            const media = [...(L.extended_entities?.media || []), ...(L.entities?.media || [])]
            const seen = new Set()
            const items = []
            for (const m of media) {
                const key = m.id_str || m.media_url_https || m.media_url
                if (seen.has(key)) continue
                seen.add(key)
                items.push(mediaItem(m))
            }
            if (items.length) {
                out.push({
                    id: L.id_str || o.rest_id || '',
                    conversationId: L.conversation_id_str || '',
                    text: L.full_text,
                    lang: L.lang || '',
                    createdAt: L.created_at || '',
                    isRetweet: Boolean(L.retweeted_status_result) || /^RT @/.test(L.full_text),
                    engagement: {
                        likes: L.favorite_count ?? null,
                        retweets: L.retweet_count ?? null,
                        replies: L.reply_count ?? null,
                        quotes: L.quote_count ?? null,
                        bookmarks: L.bookmark_count ?? null,
                        views: null,
                    },
                    media: items,
                })
            }
        }
        for (const k in o) walk(o[k])
    }
    walk(j)
    return { user: u, tweets: out, raw: j }
}

function mediaItem(m) {
    const oi = m.original_info || {}
    const base = {
        id: m.id_str || '',
        type: m.type || 'photo',
        width: oi.width || null,
        height: oi.height || null,
        image: m.media_url_https || m.media_url || '',
    }
    if (m.type === 'video' || m.type === 'animated_gif') {
        const vi = m.video_info || {}
        const variants = (vi.variants || [])
            .filter(v => v.url && v.bitrate)
            .map(v => ({ url: v.url, bitrate: v.bitrate, type: v.content_type || 'video/mp4' }))
            .sort((a, b) => b.bitrate - a.bitrate)
        // dedupe by bitrate
        const byB = new Map()
        for (const v of variants) if (!byB.has(v.bitrate)) byB.set(v.bitrate, v)
        const m3u8 = (vi.variants || []).find(v => /\.m3u8/.test(v.url || ''))
        return {
            ...base,
            durationMs: vi.duration_millis || null,
            aspectRatio: oi.width && oi.height ? +(oi.width / oi.height).toFixed(4) : null,
            variants: [...byB.values()],
            hls: m3u8 ? m3u8.url : null,
        }
    }
    return base
}

const variantHeight = (u) => Number((String(u).match(/\/avc1\/(\d+)x(\d+)\//) || [])[2]) || 0

export const pickVariant = (item, want) => {
    if (!item.variants?.length) return null
    if (want === 'best') return [...item.variants].sort((a, b) => b.bitrate - a.bitrate)[0]
    const target = /^(\d+)k$/i.test(want)
        ? Number(want.replace(/k$/i, '')) * 540
        : Number(String(want).replace('p', ''))
    return [...item.variants].sort((a, b) => {
        const da = Math.abs(variantHeight(a.url) - target), db = Math.abs(variantHeight(b.url) - target)
        return da - db || b.bitrate - a.bitrate
    })[0]
}

const safeName = (t, n = 50) => {
    const s = String(t || 'x')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
        .replace(/^[.\s@]+/, '')
        .replace(/\.{2,}/g, '.')
        .replace(/\s+/g, ' ')
        .trim().slice(0, n).replace(/[.\s]+$/, '')
    return s || 'x'
}

export async function downloadFast(url, out) {
    const probe = await fetch(url, { headers: { ...HDR_CDN, range: 'bytes=0-0' } })
    const total = Number(String(probe.headers.get('content-range') || '').split('/')[1]) || 0
    let done = 0
    const fd = fs.openSync(out, 'w')
    try {
        for (let attempt = 0; attempt < 5; attempt++) {
            const headers = { ...HDR_CDN }
            if (done > 0) headers.range = `bytes=${done}-`
            let r
            try {
                r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) })
            } catch (e) {
                if (attempt === 4) throw new Error(`download gagal (${e.message})`)
                await sleep(400 * (attempt + 1)); continue
            }
            if (!r.ok && r.status !== 206) {
                if (attempt === 4) throw new Error(`CDN nolak download (${r.status})`)
                await sleep(400 * (attempt + 1)); continue
            }
            if (done > 0 && r.status === 200) done = 0
            try {
                for await (const c of r.body) {
                    const buf = Buffer.from(c)
                    fs.writeSync(fd, buf, 0, buf.length, done)
                    done += buf.length
                }
            } catch (e) {
                if (attempt === 4) throw new Error(`download gagal (${e.message})`)
                await sleep(400 * (attempt + 1)); continue
            }
            if (!total || done >= total) return done
        }
        throw new Error(`download kepotong di ${done}/${total || '?'} byte`)
    } finally {
        fs.closeSync(fd)
    }
}

const findTweet = async (tweetId, user) => {
    const tl = await timeline(user, { count: 40 })
    const hit = tl.tweets.find(t => t.id === tweetId)
    if (hit) return { ...hit, author: tl.user }
    throw new Error(`tweet ${tweetId} nggak ada di 40 tweet terbaru @${user}. Tweet lama nggak bisa diambil tanpa login — pake akun pemiliknya atau tandai @ dia.`)
}

//CLI
const QUALITY_LABEL = { '4k': '4K (2160p)', '2k': '2K (1440p)', '1080p': '1080p', '720p': '720p', '480p': '480p', best: 'terbaik' }

async function main() {
    const av = process.argv.slice(2)
    if (!av.length || av[0] === '-h' || av[0] === '--help') help()
    const raw = av[0]
    const arg0 = raw.startsWith('@') ? raw.slice(1) : raw
    const hasStatus = /\/status\//.test(raw)
    const bareId = /^\d{10,25}$/.test(raw)
    const isTweetTarget = hasStatus || bareId
    const MODES = [...QUALITIES, 'list', 'info', 'photo', 'gif', 'profile', 'best']
    const MODE = MODES.includes(av[1]) ? av[1] : undefined
    const pos = av.slice(1).filter(x => x !== MODE)

    //username
    if (!isTweetTarget) {
        const limit = Number(pos[0]) || 40
        const tl = await timeline(arg0, { count: limit })
        if (MODE === 'profile') {
            console.log(JSON.stringify({
                status: 'success',
                mode: 'profile',
                user: tl.user,
                watermark: WM, source: SRC,
            }, null, 2))
            return
        }
        if (!tl.tweets.length) throw new Error(`@${arg0} nggak punya tweet ber-media di ${limit} terbaru`)

        console.log(JSON.stringify({
            status: 'success',
            user: tl.user,
            count: tl.tweets.length,
            tweets: tl.tweets.map(t => ({
                id: t.id,
                url: `https://x.com/${tl.user.username}/status/${t.id}`,
                text: t.text, createdAt: t.createdAt, isRetweet: t.isRetweet,
                engagement: t.engagement,
                media: t.media.map(m => ({
                    type: m.type, width: m.width, height: m.height,
                    durationMs: m.durationMs, variants: (m.variants || []).length, image: m.image,
                })),
            })),
            watermark: WM, source: SRC,
        }, null, 2))
        return
    }

    const m = raw.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,20})\/status\/(\d{6,25})/)
    const tweetId = m ? m[2] : (bareId ? raw : null)
    const userFromUrl = m ? m[1] : null
    const userArg = av.find(a => /^@?[A-Za-z0-9_]{1,20}$/.test(a) && a !== raw && a !== MODE)?.replace('@', '')
    const who = userFromUrl || userArg
    if (!tweetId) throw new Error('bukan URL tweet / tweet ID. Bentuk: https://x.com/<user>/status/<id>')
    if (!who) throw new Error('kalau cuma pakai ID polos, tambahin username: node xGst.mjs <id> <username> [mode]')
    const t = await findTweet(tweetId, who)
    //photo: semua foto di tweet
    if (MODE === 'photo') {
        const pics = t.media.filter(x => x.type === 'photo')
        if (!pics.length) throw new Error('tweet ini nggak ada foto')
        const dir = pos.find(x => !/^\d+$/.test(x)) || `x-${t.id}`
        fs.mkdirSync(dir, { recursive: true })
        const files = []
        for (const [i, p] of pics.entries()) {
            const f = path.join(dir, `${String(i + 1).padStart(2, '0')}_${safeName(t.text)}.jpg`)
            const r = await fetch(p.image, { headers: HDR_CDN })
            if (!r.ok) throw new Error(`foto ${i + 1} gagal (${r.status})`)
            fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()))
            files.push({ file: path.resolve(f), bytes: _size(f), width: p.width, height: p.height, url: p.image })
        }
        console.log(JSON.stringify({
            status: 'success',
            id: t.id, url: `https://x.com/${t.author.username}/status/${t.id}`,
            text: t.text, author: slimAuthor(t.author), engagement: t.engagement,
            createdAt: t.createdAt, lang: t.lang,
            mode: 'photo', files, count: files.length,
            watermark: WM, source: SRC,
        }, null, 2))
        return
    }

    if (MODE === 'profile') throw new Error('mode profile cuma buat input username: node xGst.mjs <username> profile')
    if (!MODE || MODE === 'info') {
        const variants = (t.media || []).map(m => ({
            type: m.type, width: m.width, height: m.height, durationMs: m.durationMs,
            aspectRatio: m.aspectRatio, image: m.image, hls: m.hls || null,
            variants: (m.variants || []).map(v => ({
                resolution: variantHeight(v.url) ? `${variantHeight(v.url)}p` : null,
                width: (String(v.url).match(/\/avc1\/(\d+)x(\d+)\//) || [])[1] || null,
                bitrate: v.bitrate, type: v.type, url: v.url,
            })),
        }))
        console.log(JSON.stringify({
            status: 'success',
            id: t.id, url: `https://x.com/${t.author.username}/status/${t.id}`,
            text: t.text, author: slimAuthor(t.author), engagement: t.engagement,
            createdAt: t.createdAt, lang: t.lang, isRetweet: t.isRetweet,
            mode: 'info', mediaCount: variants.length,
            hasVideo: variants.some(m => m.type === 'video' || m.type === 'animated_gif'),
            hasPhoto: variants.some(m => m.type === 'photo'),
            media: variants,
            watermark: WM, source: SRC,
        }, null, 2))
        return
    }

    if (MODE === 'gif') {
        const gif = t.media.find(x => x.type === 'animated_gif' && x.variants?.length)
        if (!gif) throw new Error('tweet ini nggak ada GIF')
        const v = pickVariant(gif, 'best')
        const out = pos.find(x => /\.\w+$/.test(x)) || `${t.id}-gif.mp4`
        const t0 = Date.now()
        const bytes = await downloadFast(v.url, out)
        console.log(JSON.stringify({
            status: 'success',
            id: t.id, url: `https://x.com/${t.author.username}/status/${t.id}`,
            text: t.text, author: slimAuthor(t.author), createdAt: t.createdAt,
            mode: 'gif', quality: 'best', resolution: gif,
            bytes, size: { bytes, mb: +(bytes / 1048576).toFixed(2) },
            file: path.resolve(out), timeSec: +((Date.now() - t0) / 1000).toFixed(2),
            watermark: WM, source: SRC,
        }, null, 2))
        return
    }

    //video
    const vid = t.media.find(x => (x.type === 'video' || x.type === 'animated_gif') && x.variants?.length)
    if (!vid) throw new Error('tweet ini nggak ada video (cuma foto, atau RT)')

    const want = MODE || '1080p'
    const v = pickVariant(vid, want)
    if (!v) throw new Error('nggak ada variant video yang bisa dipake')
    const height = variantHeight(v.url) || vid.height
    const out = pos.find(x => /\.\w+$/.test(x)) || `${t.id}-${height}p.mp4`
    const t0 = Date.now()
    const bytes = await downloadFast(v.url, out)
    console.log(JSON.stringify({
        status: 'success',
        id: t.id, url: `https://x.com/${t.author.username}/status/${t.id}`,
        text: t.text, author: slimAuthor(t.author), engagement: t.engagement,
        createdAt: t.createdAt, lang: t.lang,
        mode: 'video', quality: `${height}p`, requested: QUALITY_LABEL[want] || want,
        resolution: vid,
        variant: { url: v.url, bitrate: v.bitrate },
        bytes, size: { bytes, mb: +(bytes / 1048576).toFixed(2) },
        file: path.resolve(out), timeSec: +((Date.now() - t0) / 1000).toFixed(2),
        watermark: WM, source: SRC,
    }, null, 2))
}

const slimAuthor = (a) => a ? {
    name: a.name, username: a.username, verified: a.verified, followers: a.followers,
} : null

main().catch(e => {
    console.error(`Error: ${e.message}`)
    if (e.rotated) console.error('Catatan: queryId X dirotasi. Ini masalah maintenance berkala, bukan bug parser.')
    process.exit(1)
})
