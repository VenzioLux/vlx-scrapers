/*
Base    : https://emailqu.com
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Email sementara EmailQu tanpa akun (API publik /api/public/emails)
- Bikin alamat ala-ala (username acak + domain terverifikasi MX)
- List + baca pesan: pengirim, subjek, isi teks + HTML, waktu, OTP
- OTP diambil dari field server kalau ada, kalau kosong ditebak dari subjek/isi
- Batas: alamat publik — siapa pun yang tahu alamatnya bisa baca, jadi pakai
  alamat sendiri; endpoint buyer/outlook butuh token/admin, sengaja tak dipakai

Usage:
  node emailqu.mjs new                  bikin alamat acak
  node emailqu.mjs domains              daftar domain terverifikasi
  node emailqu.mjs inbox <alamat>       list + isi pesan
  node emailqu.mjs read  <alamat> <id>  satu pesan

Contoh:
  node emailqu.mjs new
  node emailqu.mjs inbox ariarocket742@pkdigitalmart.online
  node emailqu.mjs read  ariarocket742@pkdigitalmart.online 12
*/

const KIND_MSG = {
    bad_input: 'invalid usage expected new | domains | inbox <address> | read <address> <id>',
    not_found: 'address has no messages or message id not found',
    ip_blocked: 'ip blocked or rate limited retry later',
    service_down: 'origin down 52x target unreachable retry later',
    network: 'network error check connection dns reset',
    parse_changed: 'parser changed site structure updated',
    redirect: 'redirect detected open redirect field',
    unknown: 'unknown error check message',
}

const mkFail = (kind, message, detail) => {
    const e = new Error(message || KIND_MSG[kind] || KIND_MSG.unknown)
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
    if (/\b(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|timeout|aborted)\b/.test(m)) return 'network'
    if (/\b(json|parse|unexpected token|structure|selector)\b/.test(m)) return 'parse_changed'
    return 'unknown'
}

const WATERMARK = 'VenzioLûx — Vloûte Cataclysm'
const SRC = 'emailqu.com'

const failOut = (e) => {
    const kind = kindOf(e)
    console.log(JSON.stringify({
        status: 'error',
        kind,
        error: (e && e.message) || KIND_MSG[kind] || KIND_MSG.unknown,
        ...(e && e.detail ? { detail: String(e.detail).slice(0, 200) } : {}),
        watermark: WATERMARK,
        source: SRC,
    }, null, 2))
    process.exit(1)
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const API = 'https://emailqu.com/api'
const T = 20000

const iso = (v) => {
    if (typeof v === 'number' && v > 0) return new Date(v > 1e12 ? v : v * 1000).toISOString()
    if (typeof v === 'string' && v) { const d = new Date(v); return isNaN(d) ? v : d.toISOString() }
    return ''
}
const otpOf = (s) => {
    const m = String(s || '').match(/(?:otp|kode|code|verification|verify|pin|token)[^\d]{0,24}(\d{4,8})/i)
    return m ? m[1] : ''
}

async function req(url, opt = {}) {
    let r
    try {
        r = await fetch(url, {
            ...opt,
            headers: { 'user-agent': UA, accept: 'application/json', ...(opt.headers || {}) },
            signal: AbortSignal.timeout(T),
        })
    } catch (e) { throw mkFail('network', 'fetch emailqu failed', e && e.message) }
    if (r.status === 403 || r.status === 429) throw mkFail('ip_blocked', 'emailqu rate limited', `http ${r.status}`)
    if (r.status >= 500) throw mkFail('service_down', 'emailqu origin down', `http ${r.status}`)
    const txt = await r.text()
    let j
    try { j = JSON.parse(txt) }
    catch { throw mkFail('parse_changed', 'emailqu returned non-json', txt.slice(0, 120)) }
    if (j.success === false) throw mkFail('not_found', `emailqu rejected: ${j.error || 'request failed'}`)
    return j
}

const mapMsg = (m) => ({
    id: String(m.id || ''),
    from: m.from || m.from_address || m.sender || '',
    subject: m.subject || '',
    otp: m.otp || otpOf(`${m.subject || ''} ${m.body_text || ''}`),
    bodyText: m.body_text || m.text_content || '',
    bodyHtml: m.body_html || m.html_content || '',
    date: iso(m.received_at || m.created_at),
})

async function main() {
    const [cmd, a, b] = process.argv.slice(2)
    if (!cmd) throw mkFail('bad_input', KIND_MSG.bad_input)

    if (cmd === 'domains') {
        const j = await req(`${API}/domains`)
        return console.log(JSON.stringify({
            status: 'success',
            source: SRC, watermark: WATERMARK,
            count: (j.domains || []).length,
            domains: (j.domains || []).map((d) => (typeof d === 'string' ? d : (d.domain || ''))).filter(Boolean),
        }, null, 2))
    }

    if (cmd === 'new') {
        const [u, d] = await Promise.all([req(`${API}/random-username`), req(`${API}/domains/random`)])
        const domain = (d.domains && d.domains[0] && d.domains[0].domain) || ''
        return console.log(JSON.stringify({
            status: 'success',
            source: SRC, watermark: WATERMARK,
            username: u.username || '',
            domain,
            address: u.username && domain ? `${u.username}@${domain}` : '',
        }, null, 2))
    }

    if (cmd === 'inbox' || cmd === 'read') {
        if (!a) throw mkFail('bad_input', KIND_MSG.bad_input)
        const j = await req(`${API}/public/emails/${encodeURIComponent(a)}`)
        const items = (j.emails || []).map(mapMsg)
        if (cmd === 'inbox') {
            return console.log(JSON.stringify({
                status: 'success',
                source: SRC, watermark: WATERMARK,
                address: j.address || a,
                count: items.length,
                messages: items,
            }, null, 2))
        }
        if (!b) throw mkFail('bad_input', KIND_MSG.bad_input)
        const one = items.find((m) => m.id === String(b))
        if (!one) throw mkFail('not_found', `message ${b} not in inbox`)
        return console.log(JSON.stringify({ status: 'success', source: SRC, watermark: WATERMARK, ...one }, null, 2))
    }

    throw mkFail('bad_input', KIND_MSG.bad_input)
}

main().catch((e) => failOut(e))