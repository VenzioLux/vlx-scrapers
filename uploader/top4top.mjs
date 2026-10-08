#!/usr/bin/env node
/*
Base    : https://top4top.me
Author  : VenzioLûx
Saluran : https://whatsapp.com/channel/0029VarG5MaGE56eduecoC0N
Features:
- Upload files to top4top.me and get direct shareable links
- Auto-fetch CSRF token and cookies
- Returns download link (file page) and file info
- Zero dependency, Node >= 18 (global fetch/Buffer/FormData)
- Watermark: VenzioLûx — Vloûte Cataclysm

Usage:
  node top4up.mjs <file-path>  -> upload file and output JSON with links
  node top4up.mjs <file-path> link -> print only download link
*/

import { fileURLToPath } from 'node:url'
import { dirname, basename } from 'node:path'
import fs from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function parseCsrf(html) {
  const m = html.match(/name=["']csrf-token["'] content=["']([^"']+)["']/i)
  return m ? m[1] : null
}

export async function uploadFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }
  const fileName = basename(filePath)
  const fileBuffer = fs.readFileSync(filePath)
  const fileStats = fs.statSync(filePath)

  const baseUrl = options.baseUrl || 'https://top4top.me'
  const lang = options.lang || 'en'
  const pageUrl = `${baseUrl}/${lang}`

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    ...options.headers
  }

  // Get page with cookies and CSRF
  const pageRes = await fetch(pageUrl, { headers, redirect: 'follow' })
  if (!pageRes.ok) throw new Error(`Failed to fetch upload page: ${pageRes.status}`)
  const html = await pageRes.text()
  const csrf = parseCsrf(html)
  if (!csrf) throw new Error('CSRF token not found')

  const setCookie = pageRes.headers.get('set-cookie') || ''
  const cookieHeader = setCookie ? setCookie.split(',').map(c => c.split(';')[0]).join('; ') : ''

  const formData = new FormData()
  formData.append('file', new Blob([fileBuffer]), fileName)
  formData.append('upload_auto_delete', options.autoDelete || '0')
  if (options.password) {
    formData.append('password', options.password)
  }

  const uploadRes = await fetch(`${baseUrl}/upload`, {
    method: 'POST',
    headers: {
      'User-Agent': headers['User-Agent'],
      'Referer': pageUrl,
      'X-CSRF-TOKEN': csrf,
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookieHeader
    },
    body: formData,
    redirect: 'follow'
  })

  if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`)
  const result = await uploadRes.json()
  if (result.type !== 'success') {
    throw new Error(result.msg || 'Upload failed')
  }

  return {
    success: true,
    filename: fileName,
    size: fileStats.size,
    downloadId: result.download_id,
    downloadLink: result.download_link,
    previewLink: result.preview_link,
    filePage: result.download_link
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: node top4up.mjs <file-path> [link]')
    process.exit(1)
  }
  uploadFile(filePath).then(res => {
    if (process.argv[3] === 'link') {
      console.log(res.downloadLink)
    } else {
      console.log(JSON.stringify(res, null, 2))
    }
  }).catch(err => {
    console.error('Error:', err.message)
    process.exit(1)
  })
}
