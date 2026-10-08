/*
Base    : https://jne.co.id/tracking-package
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Lacak kiriman JNE pakai nomor resi + 5 digit terakhir no penerima
- Alurnya sama persis kayak situs resmi: ambil CSRF token, submit resi,
  verifikasi 5 digit lewat /load-verify, ikuti url hasilnya, lalu parse
- Dua bentuk halaman hasil, dua-duanya dibaca:
  - cekresi.jne.co.id: data aslinya ada di window.allTrackingData, lengkap
    (layanan, asal, tujuan, estimasi, POD, koli, berat, barang, pengirim,
    penerima, riwayat perpindahan)
  - halaman /tracking-package: tabel ringkasan + tabel detail
- cekresi.jne.co.id itu CodeIgniter: wajib dikirim header referer, dan
  cookie jne.co.id bikin dia balas "Disallowed Key Characters"
- Nol browser, nol cookie akun, nol dependency, Node >= 18
- Semua output CLI = JSON

Usage:
  node jnetrack.mjs <no_resi> <no_penerima_5digit_terakhir>

Contoh:
  node jnetrack.mjs 0191512400030154 44712
  -> {"status":"success","resi":"0191512400030154","service":"REG",...}
*/

import path from 'node:path'

const BASE = 'https://jne.co.id'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const WATERMARK = 'VenzioLûx — Vloûte Cataclysm'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

//label
const KEYMAP = {
    'no. awb': 'awb', 'no awb': 'awb', 'awb': 'awb', 'air waybill': 'awb',
    'nomor resi': 'awb', 'no resi': 'awb', 'resi': 'awb',
    'services': 'service', 'service': 'service', 'shipment service': 'service',
    'layanan': 'service', 'jasa': 'service',
    'destination city': 'destination', 'destination': 'destination',
    'kota tujuan': 'destination', 'tujuan': 'destination',
    'items recipients': 'itemsRecipient', 'item recipients': 'itemsRecipient',
    'received date': 'receivedDate', 'tanggal terima': 'receivedDate',
    'recipients': 'recipient', 'recipient': 'recipient', 'penerima': 'recipient',
    'status': 'status', 'shipment status': 'status', 'keterangan': 'status',
    'date': 'date', 'tanggal': 'date', 'time': 'time', 'jam': 'time',
    'city': 'city', 'kota': 'city', 'location': 'city', 'lokasi': 'city',
    'from': 'from', 'dari': 'from', 'asal': 'from', 'origin': 'from', 'to': 'to',
    'estimate delivery': 'estimate', 'estimated delivery': 'estimate',
    'estimasi pengiriman': 'estimate', 'estimasi tiba': 'estimate',
    'pod date': 'podDate', 'tanggal pod': 'podDate',
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function _unescape(s) {
    return s.replace(/&(?:#[xX][0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (m) => {
        const inner = m.slice(1, -1)
        const low = inner.toLowerCase()
        if (low === 'amp') return '&'
        if (low === 'lt') return '<'
        if (low === 'gt') return '>'
        if (low === 'quot') return '"'
        if (low === 'apos') return "'"
        if (low === 'nbsp') return ' '
        try {
            if (inner[0] === '#') {
                const code = inner[1] === 'x' || inner[1] === 'X'
                    ? parseInt(inner.slice(2), 16)
                    : parseInt(inner.slice(1), 10)
                if (code > 31 && code !== 127) return String.fromCodePoint(code)
            }
        } catch { /* angka rusak, biarkan */ }
        return ''
    })
}

function _strip(html) {
    return _unescape(String(html).replace(/<[^>]*>/g, ' '))
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function _lines(html) {
    const t = String(html)
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|tr|li|h[1-6]|td|th|dt|dd|section)>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
    return _unescape(t)
        .replace(/[\u0000-\u001f\u007f]+/g, '\n')
        .split('\n')
        .map(s => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
}

function _key(label) {
    const l = String(label || '').toLowerCase().replace(/\s+/g, ' ').replace(/[:*]+\s*$/, '').trim()
    if (!l) return ''
    if (KEYMAP[l]) return KEYMAP[l]
    for (const k of Object.keys(KEYMAP)) if (l === k) return KEYMAP[k]
    return l.replace(/[^a-z0-9]+/g, ' ').trim()
}

//semua tabel jadi { header, rows }
function _tables(html) {
    const out = []
    const tre = /<table\b[\s\S]*?<\/table>/gi
    let tm
    while ((tm = tre.exec(String(html)))) {
        const tab = tm[0]
        const trre = /<tr\b[\s\S]*?<\/tr>/gi
        const rawRows = []
        let rm
        while ((rm = trre.exec(tab))) {
            const cells = []
            const cre = /<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1>/gi
            let cm
            while ((cm = cre.exec(rm[0]))) {
                const lm = cm[2].match(/data-label\s*=\s*["']([^"']+)["']/i)
                cells.push({ tag: cm[1].toLowerCase(), label: lm ? lm[1] : '', text: _strip(cm[3]) })
            }
            if (cells.length) rawRows.push(cells)
        }
        if (!rawRows.length) continue
        const head = rawRows.find(r => r.some(c => c.tag === 'th'))
        const header = head ? head.map(c => c.text) : []
        const rows = []
        for (const cells of rawRows) {
            if (cells === head) continue
            if (cells.every(c => c.tag === 'th')) continue
            const rec = {}
            cells.forEach((c, i) => {
                const key = _key(c.label) || _key(header[i] || '') || `c${i}`
                if (c.text !== '') rec[key] = c.text
            })
            if (Object.keys(rec).length) rows.push(rec)
        }
        if (rows.length) out.push({ header, rows })
    }
    return out
}

const RE_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[\s/-][A-Za-z]{3}[\s/-]\d{2,4}\b|\b\d{8}\b|\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/

//timestamp
function _splitDT(s) {
    const m = String(s || '').trim()
        .match(/^(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/)
    return m ? { date: m[1], time: m[2] || '' } : { date: '', time: '' }
}

const _dash = (v) => {
    const s = String(v === undefined || v === null ? '' : v).trim()
    return s === '-' || s === '' ? '' : s
}

function _brace(text, start) {
    let depth = 0
    let str = false
    let esc = false
    for (let i = start; i < text.length; i++) {
        const c = text[i]
        if (str) {
            if (esc) esc = false
            else if (c === '\\') esc = true
            else if (c === '"') str = false
            continue
        }
        if (c === '"') str = true
        else if (c === '{') depth++
        else if (c === '}') {
            depth--
            if (depth === 0) return text.slice(start, i + 1)
        }
    }
    return ''
}

function _allData(html) {
    const s = String(html)
    const i = s.indexOf('window.allTrackingData')
    if (i < 0) return null
    const j = s.indexOf('{', s.indexOf('=', i))
    if (j < 0) return null
    const raw = _brace(s, j)
    if (!raw) return null
    try {
        const o = JSON.parse(raw)
        return o && typeof o === 'object' && Object.keys(o).length ? o : null
    } catch { return null }
}

function _histLive(h) {
    const t = String((h && h.title) || '').trim()
    const kota = (t.match(/\[([^\]]*)\]/) || [])[1] || ''
    const status = t.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
    const dt = _splitDT(h && h.date)
    return { date: dt.date, time: dt.time, city: kota.trim(), status: status || t, raw: t }
}

// window.allTrackingData
function _fromLive(all, resi, detailUrl) {
    const keys = Object.keys(all)
    const pakai = all[resi] || all[keys[0]] || {}
    const rows = keys.map((k) => {
        const a = all[k] || {}
        return {
            awb: _dash(a.resiNumber) || k,
            service: _dash(a.service),
            destination: _dash(a.to),
            itemsRecipient: '',
            receivedDate: _dash(a.shipmentDate),
            recipient: _dash(a.receiverNameDetail) || _dash(a.receiverName),
            status: _dash(a.currentStatus),
        }
    })
    const history = (pakai.history || []).filter(h => h && (h.title || h.date)).map(_histLive)
    const detail = {
        from: _dash(pakai.from),
        to: _dash(pakai.to),
        service: _dash(pakai.service),
        shipmentDate: _dash(pakai.shipmentDate),
        estimateDelivery: _dash(pakai.estimateDelivery),
        podDate: _dash(pakai.podDate),
        koli: _dash(pakai.koli),
        weight: _dash(pakai.weight),
        goodDescription: _dash(pakai.goodDescription),
        shipperName: _dash(pakai.shipperName),
        shipperCity: _dash(pakai.shipperCity),
        receiverName: _dash(pakai.receiverNameDetail) || _dash(pakai.receiverName),
        receiverCity: _dash(pakai.receiverCityDetail),
    }
    for (const k of Object.keys(detail)) if (!detail[k]) delete detail[k]
    const out = {
        resi,
        detailUrl,
        service: _dash(pakai.service),
        destination: _dash(pakai.to),
        receivedDate: _dash(pakai.shipmentDate),
        recipient: _dash(pakai.receiverNameDetail) || _dash(pakai.receiverName),
        shipmentStatus: _dash(pakai.currentStatus),
        rows,
        history,
        watermark: WATERMARK,
        source: 'jne.co.id',
    }
    if (Object.keys(detail).length) out.detail = detail
    return out
}
const RE_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b|\b(?:0[0-9]|1[0-9]|2[0-3])[0-5][0-9]\b/

function _splitTime(s) {
    const t = String(s || '').trim()
    const m = t.match(RE_TIME)
    if (!m) return { time: '', rest: t }
    return { time: m[0], rest: (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() }
}

function _histEntry(cells) {
    const vals = (Array.isArray(cells) ? cells : [cells])
        .map(c => (typeof c === 'string' ? c : (c && c.text) || ''))
        .filter(Boolean)
    const rec = { date: '', time: '', city: '', status: '', raw: vals.join(' | ') }
    const rest = []
    for (let v of vals) {
        const dm = v.match(RE_DATE)
        if (dm) { if (!rec.date) rec.date = dm[0]; v = v.split(RE_DATE).join(' ') }
        const sp = _splitTime(v)
        if (!rec.time && sp.time && sp.rest.replace(/[\s|:,\-/.]/g, '').length <= 6) {
            rec.time = sp.time
            v = sp.rest
        }
        v = v.replace(/\s+/g, ' ').trim()
        if (v) rest.push(v)
    }
    
    if (!rec.time && rest.length) {
        const tail = rest[rest.length - 1]
        const m = tail.match(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?|\d{4})$/)
        if (m) { rec.time = m[1]; rest[rest.length - 1] = tail.slice(0, m.index).trim() }
    }
    
    const status = rest[0] || ''
    rec.status = status
    rec.city = rest.length > 1 ? rest[rest.length - 1] : ''
    return rec
}

function _pair(lines, labels) {
    for (const label of labels) {
        const same = new RegExp('^' + esc(label) + '\\s*:\\s*(.+)$', 'i')
        const own = new RegExp('^' + esc(label) + '\\s*$', 'i')
        const spa = new RegExp('^' + esc(label) + '\\s+(.+)$', 'i')
        for (let i = 0; i < lines.length; i++) {
            let m = lines[i].match(same)
            if (m) return m[1].trim()
            if (m = lines[i].match(spa)) return m[1].trim()
            if (own.test(lines[i])) {
                const nxt = lines.slice(i + 1, i + 3).find(v => v && v.length < 200)
                if (nxt) return nxt
            }
        }
    }
    return ''
}

const STOP = /^(tracking|pelacakan|customer service|footer|kami menggunakan cookie|we use cookies|hubungi kami|berita|promo|faq|produk dan layanan|solusi bisnis)/i

function _historyFromLines(lines) {
    const start = lines.findIndex(l => /^(history status|status history|riwayat status|riwayat|history)\s*:?\s*$/i.test(l))
    if (start < 0) return []
    const out = []
    for (let i = start + 1; i < lines.length && out.length < 80; i++) {
        const l = lines[i]
        if (STOP.test(l)) break
        if (/^(shipment service|estimate delivery|pod date|no\. awb|services|destination city)\b/i.test(l)) break
        if (l.length < 3) continue
        const e = _histEntry([l])
        if (e.date || e.time || e.status) out.push(e)
    }
    return out
}

export function parse(html, resi = '', detailUrl = '') {
    const live = _allData(html)
    if (live) return _fromLive(live, resi, detailUrl)
    const tabs = _tables(html)
    const lines = _lines(html)
    const kindOf = (t) => {
        const keys = new Set()
        for (const r of t.rows) for (const k of Object.keys(r)) keys.add(k)
        if (keys.has('awb') || t.header.some(h => /awb|resi/i.test(h))) return 'summary'
        if (keys.has('from') || keys.has('to') || keys.has('estimate') || keys.has('podDate')) return 'detail'
        if (keys.has('date') || keys.has('time')) return 'history'
        if (t.rows.some(r => { const e = _histEntry(Object.values(r)); return Boolean(e.date || e.time) })) return 'history'
        if (/history|riwayat/i.test(t.header.join(' '))) return 'history'
        return ''
    }
    const kinds = tabs.map(kindOf)
    const sumTab = tabs.find((t, i) => kinds[i] === 'summary')
    const histTab = tabs.find((t, i) => kinds[i] === 'history')
    const detTab = tabs.find((t, i) => kinds[i] === 'detail')
    const rows = sumTab ? sumTab.rows.map(r => ({
        awb: r.awb || '', service: r.service || '', destination: r.destination || '',
        itemsRecipient: r.itemsRecipient || '', receivedDate: r.receivedDate || '',
        recipient: r.recipient || '', status: r.status || '',
    })) : []

    let detail = {}
    if (detTab) detail = { ...(detTab.rows[0] || {}) }

    detail.from = detail.from || _pair(lines, ['From', 'Dari', 'Asal', 'Origin'])
    detail.to = detail.to || _pair(lines, ['To', 'Tujuan'])
    detail.service = detail.service || _pair(lines, ['Shipment Service', 'Layanan'])
    detail.estimate = detail.estimate || _pair(lines, ['Estimate Delivery', 'Estimated Delivery', 'Estimasi Pengiriman', 'Estimasi Tiba'])
    detail.podDate = detail.podDate || _pair(lines, ['Pod Date', 'Tanggal POD'])
    for (const k of Object.keys(detail)) if (!detail[k]) delete detail[k]

    let history = histTab ? histTab.rows.map(r => {
        const e = _histEntry(Object.values(r))
        return {
            date: r.date || e.date, time: r.time || e.time,
            city: r.city || e.city, status: r.status || r.keterangan || e.status,
            raw: e.raw,
        }
    }) : []
    if (!history.length) history = _historyFromLines(lines)

    const first = rows[0] || {}
    const out = {
        resi,
        detailUrl,
        service: first.service || detail.service || '',
        destination: first.destination || detail.to || '',
        receivedDate: first.receivedDate || detail.podDate || '',
        recipient: first.recipient || first.itemsRecipient || '',
        shipmentStatus: first.status || '',
        rows,
        history,
        watermark: WATERMARK,
        source: 'jne.co.id',
    }
    if (Object.keys(detail).length) out.detail = detail
    return out
}

//sesi cookie + csrf
function _cookieLine(jar) {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function _eat(jar, res) {
    const h = res.headers
    let list = []
    if (typeof h.getSetCookie === 'function') list = h.getSetCookie() || []
    if (!list.length) {
        const one = h.get('set-cookie')
        if (one) list = one.split(/,(?=[^ ;]+=)/)
    }
    for (const c of list) {
        const pair = c.split(';')[0]
        const i = pair.indexOf('=')
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
    }
}

async function _fetchOnce(url, opts, tries = 4) {
    let last = ''
    for (let i = 0; i < tries; i++) {
        try {
            const ctrl = new AbortController()
            const t = setTimeout(() => ctrl.abort(), 60000)
            try { return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'manual' }) }
            finally { clearTimeout(t) }
        } catch (e) {
            last = (e.cause && (e.cause.code || e.cause.message)) || e.message || 'timeout'
            if (i < tries - 1) await sleep(1500 * (i + 1))
        }
    }
    throw new Error(`jne.co.id gak bisa jawab (${last}). Coba lagi beberapa menit lagi.`)
}

async function _req(jar, url, opts = {}) {
    let { method = 'GET', form, headers = {}, follow = true } = opts
    let cur = url
    for (let hop = 0; hop <= 5; hop++) {
        const h = Object.assign({
            'user-agent': UA,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'id-ID,id;q=0.9,en;q=0.8',
        }, headers)
        const ck = _cookieLine(jar)
        if (ck) h.cookie = ck
        let body = null
        if (form && method !== 'GET') {
            h['content-type'] = 'application/x-www-form-urlencoded'
            body = form
        }
        const res = await _fetchOnce(cur, { method, headers: h, body })
        _eat(jar, res)
        const loc = res.headers.get('location')
        if (follow && loc && res.status >= 300 && res.status < 400) {
            cur = new URL(loc, cur).toString()
            method = 'GET'
            form = null
            continue
        }
        const text = await res.text()
        return { status: res.status, text, url: cur }
    }
    throw new Error('terlalu banyak redirect dari jne.co.id.')
}

//alur resmi jne
async function _open(jar) {
    const r = await _req(jar, `${BASE}/tracking-package`, { headers: { referer: `${BASE}/` } })
    if (r.status !== 200) throw new Error(`halaman tracking gagal dibuka (HTTP ${r.status}).`)
    const m = r.text.match(/name="_token"\s+value="([^"]+)"/)
    if (!m) throw new Error('CSRF token JNE gak ketemu, halaman situsnya mungkin lagi berubah.')
    return m[1]
}

async function _ask(jar, token, resi) {
    const r = await _req(jar, `${BASE}/tracking-package`, {
        method: 'POST',
        form: new URLSearchParams({ _token: token, 'cek-resi': resi }).toString(),
        headers: { referer: `${BASE}/tracking-package`, origin: BASE },
    })
    const m = r.text.match(/name="_token"\s+value="([^"]+)"/)
    return { token: m ? m[1] : token }
}

async function _verify(jar, token, resi, digits) {
    const r = await _req(jar, `${BASE}/load-verify`, {
        method: 'POST',
        form: new URLSearchParams({ _token: token, resi_: resi, num_all: digits }).toString(),
        headers: {
            referer: `${BASE}/tracking-package`,
            origin: BASE,
            'x-requested-with': 'XMLHttpRequest',
            accept: 'application/json, text/plain, */*',
        },
    })
    let d = null
    try { d = JSON.parse(r.text) } catch { /* balasannya bukan JSON */ }
    if (!d || d.status !== true || !d.url) return { error: d && d.error ? d.error : `HTTP ${r.status}` }
    return { url: d.url }
}

async function _result(jar, url) {
    let u
    try { u = new URL(url, BASE) } catch { throw new Error(`url hasil tracking gak valid: ${url}`) }
    if (!/(^|\.)jne\.co\.id$/i.test(u.hostname)) throw new Error(`url hasil di luar domain JNE: ${u.hostname}`)
    //cekresi pakai framework beda, jadi cookie jne jangan ikut dikirim
    const pakai = /^cekresi\./i.test(u.hostname) ? new Map() : jar
    const r = await _req(pakai, u.toString(), { headers: { referer: `${BASE}/tracking-package` } })
    if (r.status !== 200) throw new Error(`halaman hasil gagal dibuka (HTTP ${r.status}).`)
    if (!r.text.trim()) throw new Error('halaman hasil kosong.')
    return r.text
}

export async function track(resi, digits) {
    const r = String(resi || '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{4,29}$/.test(r))
        throw new Error(`nomor resi gak valid: "${r}". Contoh: 0191512400030154 atau CM91403298056.`)
    const d = String(digits ?? '').trim()
    if (!/^\d{5}$/.test(d))
        throw new Error(`5 digit terakhir no penerima harus 5 angka, contoh: 44712.`)

    const jar = new Map()
    const token = await _open(jar)
    const ask = await _ask(jar, token, r)
    const v = await _verify(jar, ask.token, r, d)
    if (v.error)
        throw new Error(`resi "${r}" gak ketemu di JNE, atau 5 digit terakhir no penerima keliru (${v.error}).`)
    const page = await _result(jar, v.url)
    return parse(page, r, v.url)
}

const _clean = (o) => { const { _raw, ...rest } = o; return rest }

if (process.argv[1] && import.meta.url.endsWith('/' + path.basename(process.argv[1]))) {
    const [, , a1, a2] = process.argv
    try {
        if (!a1 || !a2) {
            console.log('JNE tracking — nomor resi + 5 digit terakhir no penerima')
            console.log('')
            console.log('pakai: node jnetrack.mjs <no_resi> <no_penerima_5digit_terakhir>')
            console.log('')
            console.log('contoh: node jnetrack.mjs 0191512400030154 44712')
            process.exit(a1 ? 1 : 0)
        }
        console.log(JSON.stringify({ status: 'success', ..._clean(await track(a1, a2)) }, null, 2))
    } catch (e) {
        console.error('GAGAL:', e.message)
        process.exit(1)
    }
}
