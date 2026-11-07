/*
Base    : https://tmailcloud.my.id
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Email sementara Tmail Cloud tanpa akun (API publik /api/email)
- Bikin alamat baru (acak atau domain sendiri) lewat /api/email/generate
- List inbox: pengirim, subjek, isi teks + HTML, kode verifikasi, waktu
- Field verification_code dari server dipakai langsung; kalau kosong ditebak
  dari subjek/isi (keyword otp/code/kode/verify/pin)
- Batas: alamat publik — siapa pun yang tahu alamatnya bisa baca, jadi pakai
  alamat sendiri; inbox bisa kadaluarsa kalau server bersihin

Usage:
  node tmail.mjs new [domain]           bikin alamat baru
  node tmail.mjs domains                daftar domain aktif
  node tmail.mjs inbox <alamat>         list pesan (isi ikut)
  node tmail.mjs read  <alamat> <id>    satu pesan penuh

Contoh:
  node tmail.mjs new tmailcloud.my.id
  node tmail.mjs inbox turbo.spark59@tmailcloud.my.id
  node tmail.mjs read  turbo.spark59@tmailcloud.my.id msg_e92253a7277a
*/

const KIND_MSG = {
    bad_input: 'invalid usage expected new [domain] | domains | inbox <address> | read <address> <id>',
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
const SRC = 'tmailcloud.my.id'

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
const API = 'https://tmailcloud.my.id/api'
const T = 20000

const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0
const iso = (ms) => num(ms) > 0 ? new Date(num(ms)).toISOString() : ''
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
    } catch (e) { throw mkFail('network', 'fetch tmailcloud failed', e && e.message) }
    if (r.status === 403 || r.status === 429) throw mkFail('ip_blocked', 'tmailcloud rate limited', `http ${r.status}`)
    if (r.status >= 500) throw mkFail('service_down', 'tmailcloud origin down', `http ${r.status}`)
    const txt = await r.text()
    let j
    try { j = JSON.parse(txt) }
    catch { throw mkFail('parse_changed', 'tmailcloud returned non-json', txt.slice(0, 120)) }
    if (j.success === false) throw mkFail('not_found', `tmailcloud rejected: ${j.error || 'request failed'}`)
    return j
}

async function main() {
    const [cmd, a, b] = process.argv.slice(2)
    if (!cmd) throw mkFail('bad_input', KIND_MSG.bad_input)

    if (cmd === 'domains') {
        const j = await req(`${API}/domains`)
        return console.log(JSON.stringify({
            status: 'success',
            source: SRC, watermark: WATERMARK,
            count: (j.domains || []).length,
            domains: (j.domains || []).map((d) => ({
                name: d.name || '',
                isDefault: !!d.is_default,
                isActive: !!d.is_active,
            })),
        }, null, 2))
    }

    if (cmd === 'new') {
        const j = await req(`${API}/email/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(a ? { domain: a } : {}),
        })
        const inbox = j.inbox || {}
        return console.log(JSON.stringify({
            status: 'success',
            source: SRC, watermark: WATERMARK,
            address: j.email || inbox.address || '',
            domain: inbox.domain || '',
            username: inbox.username || '',
            isPermanent: !!inbox.is_permanent,
            expiresAt: iso(inbox.expires_at),
        }, null, 2))
    }

    if (cmd === 'inbox') {
        if (!a) throw mkFail('bad_input', KIND_MSG.bad_input)
        const j = await req(`${API}/email/inbox/${encodeURIComponent(a)}`)
        const items = (j.messages || []).map((m) => ({
            id: m.id || '',
            from: m.sender || '',
            fromName: m.sender_name || '',
            subject: m.subject || '',
            verificationCode: m.verification_code || otpOf(`${m.subject || ''} ${m.body_text || ''}`),
            bodyText: m.body_text || '',
            bodyHtml: m.body_html || '',
            date: iso(m.created_at),
            isRead: !!m.is_read,
            isStarred: !!m.is_starred,
        }))
        return console.log(JSON.stringify({
            status: 'success',
            source: SRC, watermark: WATERMARK,
            address: j.address || a,
            count: items.length,
            messages: items,
        }, null, 2))
    }

    if (cmd === 'read') {
        if (!a || !b) throw mkFail('bad_input', KIND_MSG.bad_input)
        const j = await req(`${API}/email/message/${encodeURIComponent(b)}`)
        const m = j.message || {}
        if (!m.id) throw mkFail('not_found', `message ${b} not found`)
        return console.log(JSON.stringify({
            status: 'success',
            source: SRC, watermark: WATERMARK,
            id: m.id || '',
            address: m.inbox_address || a,
            from: m.sender || '',
            fromName: m.sender_name || '',
            subject: m.subject || '',
            verificationCode: m.verification_code || otpOf(`${m.subject || ''} ${m.body_text || ''}`),
            bodyText: m.body_text || '',
            bodyHtml: m.body_html || '',
            date: iso(m.created_at),
        }, null, 2))
    }

    throw mkFail('bad_input', KIND_MSG.bad_input)
}

main().catch((e) => failOut(e))
