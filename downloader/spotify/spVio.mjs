/*
Base    : https://open.spotify.com (+ engine spotidown.app)
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Search Spotify (lagu, album, artist, playlist, podcast) tanpa login & tanpa API key
- Metadata super lengkap: judul, artist, album, tahun, durasi, track/disc number,
  genre, label, copyright, cover (64/300/640/1200), playcount, rating, ISRC,
  EAN, Explicit, popularitas, related track/album, video, credits
- Lyrics sinkron (LRC) per baris + plain text, dari LRCLIB
- Detail album (semua track +_sample), artist (top track, album, related),
  playlist (jumlah track, total durasi, owner, follower)
- Audio MP3 FULL-DURATION 320kbps — multi-engine: spotidown.app (full) ->
  preview resmi 30 detik (fallback). Sumber engine dicatat di output (`engine`).
- Cover art sampai 1200px
- Auth otomatis: token anonim (TOTP) -> client-token -> Pathfinder GraphQL
- Nol cookie akun, nol login, nol dependency, Node >= 18
- Engine lain: spotubedl.com (protokol ECDH P-256 + HKDF + AES-GCM) udah
  ke-mapping tapi belum diport; spotyloader.com = Cloudflare Turnstile.
- Semua output CLI = JSON (gampang ditelan bot/API, tinggal parse)

Usage:
  node spVio.mjs search "<keyword>" [jumlah]        cari apa aja
  node spVio.mjs <link|id> [info]                  metadata track
  node spVio.mjs <link|id> album                   isi album + semua track
  node spVio.mjs <link|id> artist                  profil artist
  node spVio.mjs <link|id> playlist                isi playlist
  node spVio.mjs <link|id> lyrics                  lyric LRC (sinkron)
  node spVio.mjs <link|id> plain                   lyric polos
  node spVio.mjs <link|id> mp3 [output]            audio FULL 320kbps (spotidown.app)
  node spVio.mjs <link|id> preview [output]        preview 30 detik (spotify.com)
  node spVio.mjs <link|id> cover [output]          cover art
*/

import fs from 'node:fs'
import path from 'node:path'
import { createHmac } from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const WEB = 'https://open.spotify.com'
const PARTNER = 'https://api-partner.spotify.com/pathfinder/v2/query'
const CLIENTTOKEN = 'https://clienttoken.spotify.com/v1/clienttoken'
const SECRETS = 'https://code.thetadev.de/ThetaDev/spotify-secrets/raw/branch/main/secrets/secretDict.json'
const LRCLIB = 'https://lrclib.net/api'
const WATERMARK = 'VenzioLûx — Vloûte Cataclysm'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// hash operation Pathfinder
const OP = {
    searchDesktop: 'eef7cc54888d91bdd6802623477873caa3948ae173a0c34fd86827b267e94c03',
    getTrack: 'a8ef9e9f02b836feb0da3003c31dbb30decc6f4b473ef89ca88c882386d668de',
    queryAlbumTracks: '6a74b456cd1735c9193d9e8ec8cc5184cad7ce13572210315229db3975964361',
    getAlbum: '6a74b456cd1735c9193d9e8ec8cc5184cad7ce13572210315229db3975964361',
    queryAlbumMerch: '3ef44ed6f17be67299538fe77faffab4075aeaf9e1085f10fc835592266711b5',
    queryArtistOverview: '9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6',
    getArtistNameAndTracks: '0adaf1a1a8a94c7ed095639c4d9456d2b1cfac16ac511d5dd2b01b6dd89f748a',
    fetchPlaylist: '8964e8eafb21aa992a7d951d256d83285c04be2105d209262901de70cb97584a',
    searchSuggestions: 'f244254b94c0e824d458ac216e0f8406a73f2f69a9ff52831a2f78fa774ff6ce',
    similarAlbumsBasedOnThisTrack: '1d1f93a737498adca2c892c73af87fc0b052afe4e1a33c989540c32413dfae17',
}

//auth
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function _b32enc(buf) {
    let bits = 0, val = 0, out = ''
    for (const b of buf) {
        val = (val << 8) | b
        bits += 8
        while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5 }
    }
    if (bits) out += B32[(val << (5 - bits)) & 31]
    return out
}
function _b32dec(s) {
    let bits = 0, val = 0
    const out = []
    for (const c of String(s).replace(/=+$/, '').toUpperCase()) {
        const i = B32.indexOf(c)
        if (i < 0) continue
        val = (val << 5) | i
        bits += 5
        if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8 }
    }
    return Buffer.from(out)
}
function _totp(secret, t = Date.now()) {
    const c = Buffer.alloc(8)
    c.writeBigUInt64BE(BigInt(Math.floor(t / 30000)))
    const h = createHmac('sha1', _b32dec(secret)).update(c).digest()
    const o = h[19] & 15
    const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
    return String(n % 1000000).padStart(6, '0')
}

let _session = null
async function _webVersion() {
    try {
        const html = await (await fetch(WEB, { headers: { 'user-agent': UA } })).text()
        const m = html.match(/web-player\.[a-f0-9]+\.js/) || html.match(/spotify-app-version"?[:=]"([\d.]+\.[a-f0-9]+)"/)
        const v = m && (m[1] || m[0].match(/\d[\d.]*\.[a-f0-9]+/)?.[0])
        if (v) return v
    } catch { }
    return '1.3.5.70.g62be614201d8'
}

async function _session_() {
    if (_session && Date.now() - _session.at < 8 * 60_000) return _session
    const clientVersion = await _webVersion()
    const dict = await (await fetch(SECRETS, { headers: { 'user-agent': UA } })).json()
    const ver = Math.max(...Object.keys(dict).map(Number))
    const bytes = dict[String(ver)]
    const hex = Buffer.from(bytes.map((b, i) => b ^ ((i % 33) + 9)).join(''), 'utf8').toString('hex')
    const code = _totp(_b32enc(Buffer.from(hex, 'hex')))
    const tUrl = `${WEB}/api/token?reason=init&productType=web-player&totp=${code}&totpServer=${code}&totpVer=${ver}`
    const tJson = await (await fetch(tUrl, { headers: { 'user-agent': UA, accept: '*/*' } })).json()
    if (!tJson.accessToken) throw new Error('Spotify gak mau kasih token anon. Kemungkinan kena rate limit, coba beberapa menit lagi.')

    // client-token
    const ctJson = await (await fetch(CLIENTTOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
        body: JSON.stringify({
            client_data: {
                client_version: clientVersion,
                client_id: tJson.clientId,
                js_sdk_data: { device_brand: 'unknown', device_model: 'unknown', os: 'windows', os_version: 'NT 10.0' },
            },
        }),
    })).json()
    if (!ctJson?.granted_token?.token) throw new Error('gagal dapat client-token Spotify. Coba lagi nanti.')

    _session = { at: Date.now(), accessToken: tJson.accessToken, clientToken: ctJson.granted_token.token, clientVersion, clientId: tJson.clientId }
    return _session
}

async function _pf(op, variables, tries = 3) {
    const hash = OP[op]
    if (!hash) throw new Error(`operation "${op}" gak dikenal di versi ini.`)
    let last = ''
    for (let i = 0; i < tries; i++) {
        const s = await _session_()
        try {
            const r = await fetch(PARTNER, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${s.accessToken}`,
                    'client-token': s.clientToken,
                    'app-platform': 'WebPlayer',
                    'spotify-app-version': s.clientVersion,
                    'content-type': 'application/json;charset=UTF-8',
                    accept: 'application/json',
                    'accept-language': 'en',
                    origin: WEB,
                    referer: WEB + '/',
                    'user-agent': UA,
                },
                body: JSON.stringify({ operationName: op, variables, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
            })
            const txt = await r.text()
            if (r.status === 200 && txt.trim().startsWith('{')) {
                const j = JSON.parse(txt)
                // NotFound = objeknya emang gak ada (ID ngawur / dihapus)
                const nf = Object.values(j.data || {}).find((v) => v?.__typename === 'NotFound')
                if (nf) { const e = new Error(nf.message?.replace(/^Object with uri '.*?'/, 'Target') || 'Target gak ketemu di Spotify.'); e.fatal = true; throw e }
                if (j.errors?.length) throw new Error(j.errors[0].message || 'query ditolak Spotify')
                return j.data
            }
            last = j?.errors?.[0]?.message || `HTTP ${r.status}`
            if (r.status === 400 && /persisted|operation/i.test(last)) { delete OP[op]; throw new Error('Spotify ganti versi web player, hash operation gak cocok lagi.') }
        } catch (e) {
            if (e.fatal) throw e
            last = e.message
        }
        _session = null
        await sleep(600 * (i + 1))
    }
    throw new Error(`query "${op}" gagal (${last}).`)
}

//helpers
const _id = (uri) => String(uri || '').split(':').pop()
const _num = (n) => Number(n) || 0
const _artists = (a) => (a?.items || []).map((x) => ({ name: x?.profile?.name || '', uri: x?.uri || '', id: _id(x?.uri) }))
const _names = (a) => _artists(a).map((x) => x.name).filter(Boolean).join(', ')
const _covers = (c) => {
    const src = (c?.sources || c?.items?.[0]?.sources || []).filter((x) => x?.url)
    const pick = (h) => src.find((x) => x.height === h)?.url || src.find((x) => !x.height)?.url || ''
    const fallback = src[src.length - 1]?.url || ''
    const any = (h) => pick(h) || fallback
    return { small: any(64), medium: any(300), large: any(640), extraLarge: any(1200), color: c?.extractedColors?.colorDark?.hex || '' }
}
const _dur = (ms) => {
    const t = Math.round((_num(ms) || 0) / 1000)
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}
const _iso = (d) => {
    if (!d) return null
    if (typeof d === 'string') return d
    if (d.isoString) return d.isoString
    if (d.year) return String(d.year)
    if (d.day && d.month) return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
    return null
}

// copyright datang sebagai {items:[{text,type}]} dari Pathfinder
const _copyright = (c) => {
    if (!c) return ''
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((x) => x?.text || String(x)).filter(Boolean).join(' | ')
    if (Array.isArray(c.items)) return c.items.map((x) => x?.text || String(x)).filter(Boolean).join(' | ')
    return c.text || ''
}

function _normTrack(t) {
    if (!t) return null
    const al = t.albumOfTrack || t.album || {}
    const ar = _artists(t.artists || t.firstArtist)
    const ms = t.duration?.totalMilliseconds ?? t.duration_ms ?? t.durationMs ?? 0
    return {
        type: 'track',
        id: _id(t.uri || t.id),
        uri: t.uri || `spotify:track:${_id(t.id)}`,
        url: `${WEB}/track/${_id(t.uri || t.id)}`,
        name: t.name || '',
        artists: ar,
        artistNames: ar.map((x) => x.name).join(', '),
        album: { id: _id(al.uri || al.id), uri: al.uri || '', name: al.name || '', url: al.uri ? `${WEB}/album/${_id(al.uri)}` : '', date: _iso(al.date), cover: _covers(al.coverArt || al.images) },
        durationMs: _num(ms),
        duration: _dur(ms),
        trackNumber: _num(t.trackNumber ?? t.track_number),
        discNumber: _num(t.discNumber ?? t.disc_number),
        explicit: !!(t.contentRating?.label === 'EXPLICIT' || t.explicit),
        rating: t.contentRating?.label || (t.explicit ? 'EXPLICIT' : ''),
        playcount: _num(t.playcount),
        popularity: _num(t.popularity),
        isrc: t.isrc || '',
        ean: t.ean || '',
        genres: (t.genres || []).map((g) => g?.name || g),
        label: t.label || t.copyrightLabel || t.recordLabel || al.label || '',
        copyright: _copyright(t.copyright || t.copyrightLine || al.copyright || al.copyrightLine),
        previewUrl: t.preview_url?.url || t.previewUrl?.url || t.audioPreview?.url || '',
        videoCount: _num(t.associatedVideoCount ?? t.associatedVideos?.totalCount),
        hasVideo: _num(t.associatedVideoCount ?? t.associatedVideos?.totalCount) > 0 || !!t.videoPreview?.url,
        uri_related: (t.associationsV3?.relatedArtists?.items || []).slice(0, 5).map((x) => ({ name: x?.profile?.name || '', uri: x?.uri || '' })),
    }
}

function _normAlbum(a) {
    if (!a) return null
    const ar = _artists(a.artists || a.artist)
    const tracks = (a.tracksV2?.items || a.tracks?.items || []).map((x) => _normTrack(x.track || x)).filter(Boolean)
    return {
        type: 'album',
        id: _id(a.uri || a.id),
        uri: a.uri || `spotify:album:${_id(a.id)}`,
        url: a.uri ? `${WEB}/album/${_id(a.uri)}` : '',
        name: a.name || '',
        artists: ar,
        artistNames: ar.map((x) => x.name).join(', '),
        date: _iso(a.date || a.releaseDate),
        releaseDatePrecision: a.date?.precision || a.release_date_precision || '',
        type_: a.type || a.album_type || '',
        copyright: _copyright(a.copyright || a.copyrightLine),
        courtesy: a.courtesyLine || '',
        label: a.label || '',
        cover: _covers(a.coverArt || a.images),
        totalTracks: _num(a.tracksV2?.totalCount ?? a.total_tracks ?? tracks.length),
        totalDurationMs: tracks.reduce((s, t) => s + t.durationMs, 0),
        explicit: !!a.explicit,
        playable: a.playability?.playable !== false,
        tracks,
        trackSamples: tracks.slice(0, 10),
    }
}

function _normArtist(x) {
    if (!x) return null
    const p = x.profile || {}
    const pic = (x.headerImage?.data?.sources || x.visualIdentity?.image?.sources || [])
    const picUrl = (h) => pic.find((i) => i.height === h || i.maxHeight === h)?.url || ''
    const disc = x.discography || {}
    const rep = x.onPlatformReputationTrait || {}
    return {
        type: 'artist',
        id: _id(x.uri || x.id),
        uri: x.uri || '',
        url: x.uri ? `${WEB}/artist/${_id(x.uri)}` : '',
        name: p.name || x.name || '',
        verified: !!(rep.verification?.isVerified || x.verified),
        registered: !!rep.verification?.isRegistered,
        followers: _num(x.stats?.followers ?? x.followerCount),
        monthlyListeners: _num(x.stats?.monthlyListeners ?? x.monthlyListeners),
        worldRank: _num(x.stats?.worldRank),
        topCities: (x.stats?.topCities?.items || []).slice(0, 5).map((c) => ({ city: c.city, country: c.country, listeners: _num(c.numberOfListeners) })),
        bio: p.biography?.text || x.bio?.text || '',
        links: (p.externalLinks?.items || []).map((l) => ({ name: l.name, url: l.url })),
        image: { large: picUrl(640), medium: picUrl(300), small: picUrl(64), header: x.headerImage?.data?.sources?.[0]?.url || '' },
        discography: {
            albums: _num(disc.albums?.totalCount),
            singles: _num(disc.singles?.totalCount),
            compilations: _num(disc.compilations?.totalCount),
            appearances: _num(disc.appearsOn?.totalCount),
        },
        topTrack: disc.topTracks?.items?.[0] ? _normTrack(disc.topTracks.items[0].track || disc.topTracks.items[0]) : null,
        topTracks: (disc.topTracks?.items || []).map((i) => _normTrack(i.track || i)).filter(Boolean),
        latest: (disc.latest?.items || []).map((i) => _normAlbum(i.album || i)).filter(Boolean),
        popularReleases: (disc.popularReleasesAlbums?.items || []).map((i) => _normAlbum(i.album || i)).filter(Boolean),
    }
}

function _normPlaylist(p) {
    if (!p) return null
    const items = p.content?.items || p.items || []
    const tracks = items.map((i) => _normTrack(i.itemV2?.data || i.track || i)).filter(Boolean)
    return {
        type: 'playlist',
        id: _id(p.uri || p.id),
        uri: p.uri || '',
        url: p.uri ? `${WEB}/playlist/${_id(p.uri)}` : '',
        name: p.name || '',
        description: p.description || '',
        owner: p.ownerV2?.data?.name || p.owner?.displayName || p.owner?.name || '',
        ownerUri: p.ownerV2?.data?.uri || p.owner?.uri || '',
        followers: _num(p.followers ?? p.followers?.totalCount ?? p.followerCount),
        likes: _num(p.likes?.totalCount),
        trackCount: _num(p.content?.totalCount ?? tracks.length),
        durationMs: tracks.reduce((s, t) => s + t.durationMs, 0),
        cover: _covers(p.images || p.visualIdentity?.squareCoverImage),
        collaborative: !!p.collaborative,
        public: p.basePermission !== 'UNFOLLOW',
        tracks,
        trackSamples: tracks.slice(0, 20),
    }
}

//resolve
export async function resolveTarget(raw, prefer = 'track') {
    let s = String(raw || '').trim()
    if (!s) return null
    if (/^[A-Za-z0-9]{22}$/.test(s)) return { kind: prefer, id: s, uri: `spotify:${prefer}:${s}` }
    let m = s.match(/(?:open\.spotify\.com\/(?:intl-[a-z]{2}\/)?)(track|album|artist|playlist|episode|show|user)\/([A-Za-z0-9]{10,30})/)
    if (m) return { kind: m[1], id: m[2], uri: `spotify:${m[1]}:${m[2]}` }
    m = s.match(/spotify:(track|album|artist|playlist|episode|show|user):([A-Za-z0-9]{10,30})/)
    if (m) return { kind: m[1], id: m[2], uri: s }
    m = s.match(/\/([A-Za-z0-9]{22})[?#]/) // share link
    if (m) {
        try {
            const r = await fetch(s, { headers: { 'user-agent': UA }, redirect: 'follow' })
            const u = r.url
            const mm = u.match(/spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|artist|playlist)\/([A-Za-z0-9]{22})/)
            if (mm) return { kind: mm[1], id: mm[2], uri: `spotify:${mm[1]}:${mm[2]}` }
            const mu = u.match(/spotify:((?:track|album|artist|playlist):[A-Za-z0-9]{22})/)
            if (mu) return { kind: mu[1].split(':')[0], id: mu[1].split(':')[1], uri: mu[1] }
        } catch { }
    }
    if (/^[A-Za-z0-9]{22}$/.test(s)) return { kind: prefer, id: s, uri: `spotify:${prefer}:${s}` }
    return null
}

//search
export async function search(keyword, { limit = 20, type = 'all', offset = 0 } = {}) {
    const term = String(keyword || '').trim()
    if (!term) throw new Error('keyword kosong.')
    const data = await _pf('searchDesktop', {
        searchTerm: term, offset, limit: Math.min(Math.max(limit, 1), 50),
        numberOfTopResults: 5,
        includeAudiobooks: true, includeArtistHasConcertsField: false,
        includePreReleases: true, includeAlbumPreReleases: false,
        includeAuthors: false, includeEpisodeContentRatingsV2: true,
        isPrefix: null, sectionFilters: ['GENERIC'],
    })
    const v = data.searchV2
    if (!v) throw new Error('Spotify gak returning hasil untuk keyword itu. Coba keyword lain.')
    const out = { tracks: [], albums: [], artists: [], playlists: [], podcasts: [], episodes: [] }

    const wrap = (x) => x?.data || x?.item?.data || x?.item || x
    for (const t of (v.tracksV2?.items || []).map(wrap)) { const n = _normTrack(t); if (n) out.tracks.push(n) }
    for (const a of (v.albumsV2?.items || []).map(wrap)) { const n = _normAlbum(a); if (n) out.albums.push(n) }
    for (const a of (v.artists?.items || []).map(wrap)) { const n = _normArtist(a); if (n) out.artists.push(n) }
    for (const p of (v.playlists?.items || []).map(wrap)) { const n = _normPlaylist(p); if (n) out.playlists.push(n) }
    for (const p of (v.podcasts?.items || []).map(wrap)) { const n = _normAlbum(p); if (n) out.podcasts.push({ ...n, type: 'podcast' }) }
    for (const e of (v.episodes?.items || []).map(wrap)) {
        const n = _normTrack(e)
        if (n) out.episodes.push({ ...n, type: 'episode', show: e?.parentEpisode?.name || e?.show?.name || '' })
    }

    const counts = {
        tracks: out.tracks.length, albums: out.albums.length, artists: out.artists.length,
        playlists: out.playlists.length, podcasts: out.podcasts.length, episodes: out.episodes.length,
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    if (!total) throw new Error(`keyword "${term}" gak ada hasilnya di Spotify.`)
    return { keyword: term, type, offset, counts, total, ...out }
}

//suggest
export async function suggest(keyword, { limit = 10 } = {}) {
    const term = String(keyword || '').trim()
    if (!term) throw new Error('keyword kosong.')
    try {
        // variabelnya `$query`, bukan searchTerm
        const d = await _pf('searchSuggestions', { query: term, limit })
        const items = d?.searchV2?.topResultsV2?.itemsV2 || []
        const out = []
        for (const it of items) {
            const x = it?.item?.data || it?.item
            const text = x?.text || x?.name || ''
            if (text) out.push({ text, uri: x?.uri || '', type: x?.__typename || '' })
        }
        return { keyword: term, count: out.length, suggestions: out.slice(0, limit) }
    } catch { return { keyword: term, count: 0, suggestions: [] } }
}

//metadata
export async function track(input) {
    const t = await resolveTarget(input, 'track')
    if (!t) throw new Error('gak bisa baca target ini. Pakai link open.spotify.com/track|album|artist|playlist/<id>, URI spotify:<tipe>:<id>, atau ID 22 karakter.')
    if (t.kind !== 'track') {
        const g = { album, artist, playlist }[t.kind]
        return g ? await g(input) : null
    }
    const d = await _pf('getTrack', { uri: t.uri, includeVideoAssociationItems: true })
    const tr = d.trackUnion
    if (!tr) throw new Error('track ini gak ketemu di Spotify.')
    const out = _normTrack(tr)
    // release date / ISRC / label gak ada di payload anonim
    const emb = await _embed(out.id).catch(() => null)
    if (emb) {
        out.previewUrl = emb.previewUrl || out.previewUrl
        out.album.releaseDate = emb.releaseDate || out.album.releaseDate
        out.album.name = out.album.name || emb.albumName
        out.album.id = out.album.id || emb.albumId
        out.album.uri = out.album.uri || emb.albumUri
        if (!out.album.cover.medium && emb.images.length) out.album.cover = _covers(emb.images)
        out.isrc = out.isrc || emb.isrc || ''
        out.label = out.label || emb.label || ''
        out.explicit = out.explicit || !!emb.explicit
        out.rating = out.rating === 'NONE' && emb.explicit ? 'EXPLICIT' : out.rating
        out.playable = emb.playable
        out.hasVideo = out.hasVideo || !!emb.hasVideo
        out.videoPreview = emb.videoPreview || ''
        out.coverColor = emb.coverColor || ''
        out.coverColorText = emb.coverColorText || ''
    }
    try {
        const rel = await _pf('similarAlbumsBasedOnThisTrack', { uri: t.uri, limit: 10, albumsOnly: true })
        out.relatedAlbums = (rel?.similarAlbums?.items || []).map(_normAlbum).filter(Boolean).slice(0, 6)
    } catch { }
    out.watermark = WATERMARK
    out.lyricsHint = 'pakai mode lyrics untuk lyric sinkron (LRC).'
    return out
}

async function _embed(id) {
    const html = await (await fetch(`${WEB}/embed/track/${id}`, { headers: { 'user-agent': UA } })).text()
    const nd = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
    if (!nd) return null
    const j = JSON.parse(nd[1])
    const e = j?.props?.pageProps?.state?.data?.entity
    if (!e) return null
    const img = e.visualIdentity?.image || []
    const hex = (c) => (c ? '#' + [c.red, c.green, c.blue].map((x) => String(x ?? 0).padStart(2, '0')).join('').slice(-6) : '')
    return {
        previewUrl: e.audioPreview?.url || '',
        albumName: '', albumId: '', albumUri: '',
        releaseDate: e.releaseDate?.isoString || '',
        isrc: e.isrc || '',
        label: e.label || e.copyrightLabel || '',
        explicit: !!e.isExplicit,
        playable: e.isPlayable !== false,
        hasVideo: !!e.hasVideo,
        videoPreview: e.videoPreview?.url || '',
        images: img.map((i) => ({ height: i?.maxHeight || 300, width: i?.maxWidth || 300, url: i?.url })),
        coverColor: hex(e.visualIdentity?.backgroundBase),
        coverColorText: hex(e.visualIdentity?.textBase),
    }
}

export async function album(input, { limit = 50 } = {}) {
    const t = await resolveTarget(input, 'album')
    if (!t) throw new Error('gak bisa baca target album ini.')
    const uri = t.kind === 'album' ? t.uri : t.uri.replace(/^[a-z]+:/, 'album:')
    // locale WAJIB string kosong, bukan 'en' (kalau 'en' metadata album hilang)
    const d = await _pf('getAlbum', { uri, locale: '', offset: 0, limit })
    const a = d.albumUnion
    if (!a) throw new Error('album ini gak ketemu di Spotify.')
    const out = _normAlbum(a)
    out.url = `${WEB}/album/${out.id}`
    out.discs = (a.discs?.items || []).map((dc, i) => ({ number: dc.number ?? i + 1, trackCount: (dc.tracks?.items || []).length }))
    out.moreByArtist = (a.moreAlbumsByArtist?.items || []).map(_normAlbum).filter(Boolean).slice(0, 10)
    out.watermark = WATERMARK
    return out
}

export async function artist(input, { limit = 20 } = {}) {
    const t = await resolveTarget(input, 'artist')
    if (!t) throw new Error('gak bisa baca target artist ini.')
    const uri = t.kind === 'artist' ? t.uri : t.uri.replace(/^[a-z]+:/, 'artist:')
    const d = await _pf('queryArtistOverview', { uri, locale: '', includePrerelease: false })
    const x = d.artistUnion
    if (!x) throw new Error('artist ini gak ketemu di Spotify.')
    const out = _normArtist(x)
    const disc = x.discography || {}
    const rel = (g) => (g?.items || []).flatMap((i) => i.releases?.items || [i.album || i]).map(_normAlbum).filter(Boolean)
    out.albums = rel(disc.albums).slice(0, limit)
    out.singles = rel(disc.singles).slice(0, limit)
    out.compilations = rel(disc.compilations).slice(0, limit)
    out.appearsOn = (disc.appearsOn?.items || []).flatMap((i) => i.appearsOnAlbums?.items || []).map((i) => i.album || i).map(_normAlbum).filter(Boolean).slice(0, limit)
    out.url = `${WEB}/artist/${out.id}`
    out.watermark = WATERMARK
    return out
}

export async function playlist(input, { limit = 100 } = {}) {
    const t = await resolveTarget(input, 'playlist')
    if (!t) throw new Error('gak bisa baca target playlist ini.')
    const uri = t.kind === 'playlist' ? t.uri : t.uri.replace(/^[a-z]+:/, 'playlist:')
    const d = await _pf('fetchPlaylist', { uri, offset: 0, limit, enableWatchFeedEntrypoint: false, includeEpisodeContentRatingsV2: true })
    const p = d.playlistV2
    if (!p) throw new Error('playlist ini gak ketemu / gak bisa diakses (kemungkinan private atau region-lock).')
    const out = _normPlaylist(p)
    out.url = `${WEB}/playlist/${out.id}`
    out.watermark = WATERMARK
    return out
}

//lyrics (LRCLIB = lyric LRC publik, sinkron per baris)
const LR_UA = { 'user-agent': 'vlx-scrapers (github.com/VenzioLux/vlx-scrapers)' }

function _lyricScore(x, t) {
    if (!x) return -1
    const plain = String(x.plainLyrics || '')
    const sync = String(x.syncedLyrics || '')
    let s = 0
    if (plain.trim().length >= 40) s += 30
    else if (plain.trim().length >= 10) s += 8
    if (sync.trim()) s += 40
    s += Math.min(plain.length / 60, 20)
    const dDiff = Math.abs((x.duration || 0) - t.durationMs / 1000)
    s += dDiff <= 3 ? 20 : dDiff <= 8 ? 8 : -Math.min(dDiff / 5, 15)
    const a = (x.artistName || '').toLowerCase()
    const first = (t.artistNames || '').split(',')[0].trim().toLowerCase()
    if (first && a.includes(first)) s += 12
    if (t.album?.name && (x.albumName || '').toLowerCase() === t.album.name.toLowerCase()) s += 6
    return s
}

export async function lyrics(input, { plain = false } = {}) {
    const t = await track(input)
    const cands = []
    try {
        const r = await fetch(`${LRCLIB}/get?track_name=${encodeURIComponent(t.name)}&artist_name=${encodeURIComponent(t.artistNames)}&album_name=${encodeURIComponent(t.album.name)}&duration=${Math.round(t.durationMs / 1000)}`, { headers: LR_UA })
        if (r.ok) cands.push(await r.json())
    } catch { }
    for (const a of t.artists.map((x) => x.name).slice(0, 2)) {
        try {
            const r = await fetch(`${LRCLIB}/search?track_name=${encodeURIComponent(t.name)}&artist_name=${encodeURIComponent(a)}`, { headers: LR_UA })
            if (r.ok) cands.push(...(await r.json()))
        } catch { }
    }
    // buang record yang lyric-nya cuma placeholder ("probe", "test", dll)
    const junk = new Set(['probe', 'test', 'lyrics', 'n/a', 'none', 'todo', 'xxx'])
    const clean = cands.filter((x) => !junk.has(String(x.plainLyrics || '').trim().toLowerCase()))
    const hit = (clean.length ? clean : cands).sort((a, b) => _lyricScore(b, t) - _lyricScore(a, t))[0]
    if (!hit || _lyricScore(hit, t) < 20) throw new Error('lyric untuk track ini belum ada di LRCLIB. Lagu niche atau cover/remix sering kosong.')

    const lines = []
    for (const raw of String(hit.syncedLyrics || '').split('\n')) {
        const m = raw.match(/^\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)\](.*)$/)
        if (!m) continue
        const ms = (+m[1] * 60 + parseFloat(m[2].replace(':', '.'))) * 1000
        lines.push({ timeMs: Math.round(ms), time: _stamp(ms), text: m[3].trim() })
    }
    lines.sort((a, b) => a.timeMs - b.timeMs)

    return {
        ...plain ? { id: t.id, name: t.name, artists: t.artistNames, plainLyrics: hit.plainLyrics || lines.map((l) => l.text).join('\n'), instrumental: !!hit.instrumental, source: 'LRCLIB' } : {
            id: t.id, name: t.name, artists: t.artistNames, album: t.album.name,
            durationMs: t.durationMs, duration: t.duration, synced: lines.length > 0,
            source: 'LRCLIB', instrumental: !!hit.instrumental, hasWordSync: !!hit.hasWordSync,
            lineCount: lines.length, lines,
            plainLyrics: hit.plainLyrics || lines.map((l) => l.text).join('\n'),
            watermark: WATERMARK,
        },
    }
}

function _stamp(ms) {
    const s = Math.floor(ms / 1000)
    return `[${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`
}

//engine spotidown.app
const SD_BASE = 'https://spotidown.app'
const SD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

class _Jar {
    constructor() { this.m = new Map() }
    _absorb(res) { for (const c of res.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; const i = kv.indexOf('='); if (i > 0) this.m.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()) } }
    toString() { return [...this.m].map(([k, v]) => `${k}=${v}`).join('; ') }
    async fetch(url, opts = {}) {
        const headers = { ...opts.headers }
        const ck = this.toString()
        if (ck) headers.cookie = ck
        const res = await fetch(url, { ...opts, headers })
        this._absorb(res)
        return res
    }
}

function _sdParseResults(html) {
    const out = []
    const formRe = /<form[^>]*name=["']submitspurl["'][^>]*>([\s\S]*?)<\/form>/gi
    let m
    while ((m = formRe.exec(html)) !== null) {
        const f = m[1]
        const data = f.match(/<input[^>]*name=["']data["'][^>]*value=["']([^"']*)["']/i)?.[1]
        if (!data) continue
        try {
            const meta = JSON.parse(Buffer.from(data, 'base64').toString())
            out.push({
                meta,
                form: {
                    data,
                    base: f.match(/<input[^>]*name=["']base["'][^>]*value=["']([^"']*)["']/i)?.[1] || '',
                    token: f.match(/<input[^>]*name=["']token["'][^>]*value=["']([^"']*)["']/i)?.[1] || '',
                },
            })
        } catch { }
    }
    return out
}

// link download di hasil /action/track
function _sdParseLinks(html) {
    let mp3 = null, cover = null
    const aRe = /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
    let m
    while ((m = aRe.exec(html)) !== null) {
        const href = m[1], text = m[2].replace(/<[^>]+>/g, ' ').trim().toLowerCase()
        if (!href) continue
        if (text.includes('download mp3') || text.includes('download audio')) mp3 = href
        if (text.includes('download cover')) cover = href
    }
    return { mp3, cover }
}

async function _sdSearch(jar, queryOrUrl) {
    await jar.fetch(`${SD_BASE}/en3`, { headers: { 'user-agent': SD_UA } }).then(r => r.text())
    const res = await jar.fetch(`${SD_BASE}/action`, {
        method: 'POST',
        headers: {
            'user-agent': SD_UA,
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'origin': SD_BASE,
            'referer': `${SD_BASE}/en3`,
            'x-requested-with': 'XMLHttpRequest',
        },
        body: new URLSearchParams({ url: queryOrUrl, 'g-recaptcha-response': '' }).toString(),
    })
    const j = await res.json()
    if (j?.error) throw new Error(j.message || 'spotidown: request error')
    return _sdParseResults(j?.data || '')
}

async function _sdDownloadTrack(jar, form) {
    const res = await jar.fetch(`${SD_BASE}/action/track`, {
        method: 'POST',
        headers: {
            'user-agent': SD_UA,
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'origin': SD_BASE,
            'referer': `${SD_BASE}/en3`,
            'x-requested-with': 'XMLHttpRequest',
        },
        body: new URLSearchParams(form).toString(),
    })
    const j = await res.json()
    if (j?.error) throw new Error(j.message || 'spotidown: download error')
    return _sdParseLinks(j?.data || '')
}

export async function spotidownFull(input) {
    const jar = new _Jar()
    const hits = await _sdSearch(jar, input)
    if (!hits.length) throw new Error('spotidown: tidak ada hasil')
    const { meta, form } = hits[0]
    const links = await _sdDownloadTrack(jar, form)
    if (!links.mp3) throw new Error('spotidown: mp3 URL tidak ditemukan')

    const res = await fetch(links.mp3, {
        headers: { 'user-agent': SD_UA, referer: `${SD_BASE}/` },
        redirect: 'manual',
    })
    if (res.status !== 200) throw new Error(`spotidown: rapid HTTP ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 10000 || (buffer[0] !== 0x49 && buffer[0] !== 0xff)) throw new Error('spotidown: interstitial, bukan mp3')
    
    const spotifyUrl = meta.tid ? `${WEB}/track/${meta.tid}` : (form.base || input)
    let t = null
    try { t = await track(spotifyUrl) } catch { }
    const base = t || {
        type: 'track', id: meta.tid || '', url: spotifyUrl, name: meta.name || '',
        artistNames: meta.artist || '', album: { name: meta.album || '' }, duration: meta.duration || '',
    }
    return {
        buffer, ...base, ext: 'mp3', mimetype: 'audio/mpeg',
        engine: 'spotidown', full: true,
        fullDurationSec: t ? Math.round(t.durationMs / 1000) : null,
        bytes: buffer.length,
        cover: links.cover || base.album?.cover?.large || base.album?.cover?.medium || '',
        watermark: WATERMARK,
    }
}

// audio
export async function previewBuffer(input) {
    const t = await track(input)
    let url = t.previewUrl
    if (!url) {
        const emb = await _embed(t.id)
        url = emb?.previewUrl || ''
    }
    if (!url) throw new Error('track ini gak punya preview audio 30 detik di Spotify.')
    const r = await fetch(url, { headers: { 'user-agent': UA, referer: WEB + '/' } })
    if (!r.ok) throw new Error(`gagal ambil preview audio (HTTP ${r.status}).`)
    const buffer = Buffer.from(await r.arrayBuffer())
    return {
        buffer, ...t, ext: 'mp3', mimetype: 'audio/mpeg',
        engine: 'spotify-preview', preview: true, previewSec: 30,
        fullDurationSec: Math.round(t.durationMs / 1000),
    }
}

export async function audioBuffer(input, { full = true } = {}) {
    if (full) {
        try { return await spotidownFull(input) } catch { }
    }
    return previewBuffer(input)
}

export async function coverBuffer(input, { size = 640 } = {}) {
    const t = await track(input)
    const pick = { 64: 'small', 300: 'medium', 640: 'large', 1200: 'extraLarge' }[size] || 'large'
    const url = t.album.cover[pick]
    if (!url) throw new Error('cover art gak ketemu untuk track ini.')
    const r = await fetch(url, { headers: { 'user-agent': UA, referer: WEB + '/' } })
    if (!r.ok) throw new Error(`gagal ambil cover (HTTP ${r.status}).`)
    const buffer = Buffer.from(await r.arrayBuffer())
    return { buffer, ...t, ext: 'jpg', mimetype: 'image/jpeg', size }
}

//CLI
const _safe = (s) => String(s || 'spotify').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'spotify'

if (process.argv[1] && import.meta.url.endsWith('/' + path.basename(process.argv[1]))) {
    const [, , a1, a2, a3] = process.argv
    const strip = (r) => { const { buffer, ...rest } = r; return rest }
    const fail = (e) => { console.error('GAGAL:', e.message); process.exit(1) }

    try {
        if (a1 === 'search') {
            if (!a2) { console.log('pakai: node spVio.mjs search "<keyword>" [jumlah]'); process.exit(0) }
            console.log(JSON.stringify({ status: 'success', ...(await search(a2, { limit: Number(a3) || 20 })) }, null, 2))
        } else if (a1 === 'suggest') {
            console.log(JSON.stringify({ status: 'success', ...(await suggest(a2, { limit: Number(a3) || 10 })) }, null, 2))
        } else if (!a1) {
            console.log('pakai: node spVio.mjs <link|id> [info|album|artist|playlist|lyrics|plain|mp3|preview|cover] [output]')
            console.log('       node spVio.mjs search "<keyword>" [jumlah]')
            console.log('       node spVio.mjs suggest "<keyword>" [jumlah]')
            process.exit(0)
        } else if (a2 === 'album') {
            console.log(JSON.stringify({ status: 'success', ...(await album(a1)) }, null, 2))
        } else if (a2 === 'artist') {
            console.log(JSON.stringify({ status: 'success', ...(await artist(a1)) }, null, 2))
        } else if (a2 === 'playlist') {
            console.log(JSON.stringify({ status: 'success', ...(await playlist(a1)) }, null, 2))
        } else if (a2 === 'lyrics' || a2 === 'lrc') {
            const r = await lyrics(a1)
            const f = a3 || `${_safe(r.name)}.lrc`
            const text = r.lines.map((l) => `${l.time}${l.text}`).join('\n') + '\n'
            fs.writeFileSync(f, text)
            console.log(JSON.stringify({ status: 'success', file: f, bytes: Buffer.byteLength(text), ...r, lines: r.lines.slice(0, 20), previewTruncated: r.lines.length > 20 }, null, 2))
        } else if (a2 === 'plain') {
            const r = await lyrics(a1, { plain: true })
            const f = a3
            if (f) { fs.writeFileSync(f, r.plainLyrics + '\n'); console.log(JSON.stringify({ status: 'success', file: f, bytes: Buffer.byteLength(r.plainLyrics), ...r }, null, 2)) }
            else console.log(r.plainLyrics || '(lyric kosong)')
        } else if (a2 === 'mp3' || a2 === 'audio') {
            const t0 = Date.now()
            const r = await audioBuffer(a1, { full: true })
            const f = a3 || `${_safe(r.name)}${r.full ? '' : '_preview30s'}.mp3`
            fs.writeFileSync(f, r.buffer)
            console.log(JSON.stringify({ status: 'success', file: f, size: { bytes: r.buffer.length, mb: +(r.buffer.length / 1048576).toFixed(2) }, timeSec: +((Date.now() - t0) / 1000).toFixed(2), ...strip(r) }, null, 2))
        } else if (a2 === 'preview') {
            const t0 = Date.now()
            const r = await previewBuffer(a1)
            const f = a3 || `${_safe(r.name)}_preview30s.mp3`
            fs.writeFileSync(f, r.buffer)
            console.log(JSON.stringify({ status: 'success', file: f, size: { bytes: r.buffer.length, kb: +(r.buffer.length / 1024).toFixed(1) }, timeSec: +((Date.now() - t0) / 1000).toFixed(2), ...strip(r) }, null, 2))
        } else if (a2 === 'cover') {
            const t0 = Date.now()
            const r = await coverBuffer(a1, { size: Number(a3) || 640 })
            const f = a3 && !Number(a3) ? a3 : `${_safe(r.name)}_cover.jpg`
            fs.writeFileSync(f, r.buffer)
            console.log(JSON.stringify({ status: 'success', file: f, size: { bytes: r.buffer.length, kb: +(r.buffer.length / 1024).toFixed(1) }, timeSec: +((Date.now() - t0) / 1000).toFixed(2), ...strip(r) }, null, 2))
        } else {
            console.log(JSON.stringify({ status: 'success', ...(await track(a1)) }, null, 2))
        }
    } catch (e) { fail(e) }
}
