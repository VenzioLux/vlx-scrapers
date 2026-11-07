/*
Base    : https://inboxkitten.com
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Baca inbox email sementara InboxKitten tanpa akun (API publik /api/v1/mail)
- List pesan: id, pengirim, subjek, waktu, ukuran, jumlah lampiran
- Isi pesan (HTML + teks) diambil lewat /getHtml pakai region+key dari list
- OTP ditebak dari subjek/isi (keyword otp/code/kode/verify/pin)
- Batas: cuma 100 pesan terakhir, dan inbox ini publik — siapa pun yang tahu
  alamatnya bisa baca isinya, jadi pakai alamat sendiri

Usage:
  node ik.mjs inbox <alamat>
  node ik.mjs read  <alamat> <id>

Contoh:
  node ik.mjs inbox test@inboxkitten.com
  node ik.mjs read  test@inboxkitten.com buKhLyyBSHavY67uDfd8uA
*/

const KIND_MSG = {
    bad_input: 'invalid usage expected inbox <address> | read <address> <id>',
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
const SRC = 'inboxkitten.com (mailgun)'

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
const API = 'https://inboxkitten.com/api/v1/mail'
const T = 20000

const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0
const iso = (ts) => num(ts) > 0 ? new Date(num(ts) * 1000).toISOString() : ''
const strip = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim()

//otp: keyword diikuti 4-8 digit
const otpOf = (s) => {
    const m = String(s || '').match(/(?:otp|kode|code|verification|verify|pin|token)[^\d]{0,24}(\d{4,8})/i)
    return m ? m[1] : ''
}

async function get(url) {
    let r
    try { r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(T) }) }
    catch (e) { throw mkFail('network', 'fetch inboxkitten failed', e && e.message) }
    if (r.status === 403 || r.status === 429) throw mkFail('ip_blocked', 'inboxkitten rate limited', `http ${r.status}`)
    if (r.status >= 500) throw mkFail('service_down', 'inboxkitten origin down', `http ${r.status}`)
    const txt = await r.text()
    let j
    try { j = JSON.parse(txt) }
    catch { throw mkFail('parse_changed', 'inboxkitten returned non-json', txt.slice(0, 120)) }
    if (!r.ok) throw mkFail('not_found', 'inboxkitten request rejected', `http ${r.status}`)
    return j
}

async function main() {
    const [cmd, addr, id] = process.argv.slice(2)
    if (!cmd || !addr) throw mkFail('bad_input', KIND_MSG.bad_input)

    const list = await get(`${API}/list?recipient=${encodeURIComponent(addr)}`)
    if (!Array.isArray(list)) throw mkFail('parse_changed', 'inboxkitten list not an array')

    const msgs = list.map((m) => ({
        id: m.id || '',
        from: (m.message && m.message.headers && m.message.headers.from) || (m.envelope && m.envelope.sender) || '',
        subject: (m.message && m.message.headers && m.message.headers.subject) || '',
        date: iso(m.timestamp),
        size: num(m.message && m.message.size),
        attachments: num(m.message && m.message.attachments && m.message.attachments.length),
        hasHtml: !!(m.storage && m.storage.region && m.storage.key),
    }))

    if (cmd === 'inbox') {
        return console.log(JSON.stringify({
            status: 'success',
            source: SRC, watermark: WATERMARK,
            address: addr,
            count: msgs.length,
            messages: msgs,
        }, null, 2))
    }

    if (cmd === 'read') {
        if (!id) throw mkFail('bad_input', KIND_MSG.bad_input)
        const raw = list.find((m) => m.id === id)
        if (!raw) throw mkFail('not_found', `message ${id} not in inbox`)
        const st = raw.storage || {}
        let html = ''
        if (st.region && st.key) {
            const h = await fetch(`${API}/getHtml?region=${encodeURIComponent(st.region)}&key=${encodeURIComponent(st.key)}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(T) })
            if (h.ok) html = await h.text()
        }
        const text = strip(html)
        const subject = (raw.message && raw.message.headers && raw.message.headers.subject) || ''
        return console.log(JSON.stringify({
            status: 'success',
            source: SRC, watermark: WATERMARK,
            id: raw.id || '',
            from: (raw.message && raw.message.headers && raw.message.headers.from) || (raw.envelope && raw.envelope.sender) || '',
            subject,
            date: iso(raw.timestamp),
            otp: otpOf(subject + ' ' + text),
            bodyText: text,
            bodyHtml: html,
        }, null, 2))
    }

    throw mkFail('bad_input', KIND_MSG.bad_input)
}

main().catch((e) => failOut(e))
