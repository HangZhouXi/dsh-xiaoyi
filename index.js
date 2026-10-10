// dsh-xiaoyi —— XiaoYi channel (wires the "XiaoYi open platform · OpenClaw mode" into the DSH host)
//
// Path: phone XiaoYi → (Huawei Cloud wss long connection) → this plugin → DSH session → reply sent back to XiaoYi as A2A frames
//
// Design principles
//  1) Depend only on node built-in modules (including our own minimal WebSocket client), no third-party packages:
//     one less package in the plugin tree is one less risk of "load failure → the whole host won't start".
//  2) Every ctx.tools.register carries output{schema,render} (missing it takes down the entire plugin tree).
//  3) Every connection action is wrapped in try/catch so apply() can never throw.
//
// Protocol notes (verified line by line against the dist of @ynhcj/xiaoyi 0.0.8-beta)
//   Connect URL: wss://hag.cloud.huawei.com/openclaw/v1/ws/link
//   Auth headers: x-access-key=AK / x-sign=Base64(HMAC-SHA256(SK, ts)) / x-ts=milliseconds / x-agent-id=agentId
//   Handshake: {"msgType":"clawd_bot_init","agentId":"..."}
//   Heartbeat: every 30s {"msgType":"heartbeat","agentId":"...","timestamp":...} (also sends a protocol-level ping)
//   Inbound: JSON-RPC 2.0, method="message/stream", sessionId=params.sessionId,
//            taskId=params.id, messageId=top-level id, text lives in params.message.parts[kind=text].text
//   Outbound: {"msgType":"agent_response", agentId, sessionId, taskId, msgDetail:"<JSON-RPC string>"}
//             msgDetail.result.kind = "status-update" (state=working, the early ack)
//                                     "artifact-update" (the body, lastChunk=true, final=true to finish)
//   Control: method="clearContext" / "tasks/cancel" / action="clear" → answer with the matching JSON-RPC response

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { randomBytes, createHmac, createHash } from 'node:crypto'
import tls from 'node:tls'
import net from 'node:net'

export const name = 'dsh-xiaoyi'
export const inject = ['tools', 'webServer']

const DEFAULT_WS_URL = 'wss://hag.cloud.huawei.com/openclaw/v1/ws/link'
const STATE_DIR = join(homedir(), '.dsh', 'xiaoyi')
const STATE_FILE = join(STATE_DIR, 'state.json')
const LOG_FILE = join(STATE_DIR, 'xiaoyi.log')
const HEARTBEAT_MS = 30000

// ── Small helpers ─────────────────────────────────────────────────────────────

function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')
  console.log('[xiaoyi] ' + line)
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(LOG_FILE, line + '\n', { flag: 'a' })
  } catch (e) { /* ignore */ }
}

function safeJson(v) {
  try { return JSON.stringify(v) } catch (e) { return String(v) }
}

function rid() {
  return randomBytes(16).toString('hex')
}

function uuid() {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)
}

function loadState() {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8')
    const s = JSON.parse(raw)
    if (s && typeof s === 'object') return s
  } catch (e) { /* ignore */ }
  return {}
}

function saveState(state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (e) { log('saveState failed', e && e.message) }
}

// ── Minimal WebSocket client (RFC6455 client side, just enough to get by) ─────
//
// Only does what we need: text frame send/receive, ping/pong, close, fragment reassembly (continuation).

class MiniWS {
  constructor(url, headers) {
    this.url = url
    this.headers = headers || {}
    this.sock = null
    this.buf = Buffer.alloc(0)
    this.handshaken = false
    this.open = false
    this.closed = false
    this.closeEmitted = false        // guarantees onclose fires only once (error and close each arrive separately)
    this.wsKey = ''                  // the Sec-WebSocket-Key used for the handshake, kept to verify Accept
    this.fragOpcode = 0
    this.fragChunks = []
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    this.onpong = null
  }

  connect() {
    let u
    try { u = new URL(this.url) } catch (e) { this._fail(e); return }
    const port = u.port ? Number(u.port) : (u.protocol === 'wss:' ? 443 : 80)
    const key = randomBytes(16).toString('base64')
    this.wsKey = key
    const path = (u.pathname || '/') + (u.search || '')
    const lines = [
      'GET ' + path + ' HTTP/1.1',
      'Host: ' + u.host,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key,
      'Sec-WebSocket-Version: 13',
    ]
    for (const k of Object.keys(this.headers)) lines.push(k + ': ' + this.headers[k])
    const req = lines.join('\r\n') + '\r\n\r\n'

    const onConnect = () => { try { this.sock.write(req) } catch (e) { this._fail(e) } }
    let sock
    try {
      if (u.protocol === 'wss:') {
        sock = tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: true }, onConnect)
      } else {
        sock = net.connect({ host: u.hostname, port }, onConnect)
      }
    } catch (e) { this._fail(e); return }

    this.sock = sock
    sock.setNoDelay(true)
    sock.on('data', (d) => this._onData(d))
    sock.on('error', (e) => this._fail(e))
    sock.on('close', () => this._closed())
  }

  sendText(text) {
    if (!this.open || !this.sock) return false
    try {
      this.sock.write(this._frame(0x1, Buffer.from(String(text), 'utf8')))
      return true
    } catch (e) { this._fail(e); return false }
  }

  ping() {
    if (!this.open || !this.sock) return
    try { this.sock.write(this._frame(0x9, Buffer.alloc(0))) } catch (e) { /* ignore */ }
  }

  close() {
    this.closed = true
    try { if (this.open && this.sock) this.sock.write(this._frame(0x8, Buffer.alloc(0))) } catch (e) { /* ignore */ }
    try { if (this.sock) this.sock.end() } catch (e) { /* ignore */ }
  }

  _fail(err) {
    if (this.onerror) { try { this.onerror(err) } catch (e) { /* ignore */ } }
    this._closed()
  }

  _closed() {
    if (this.closeEmitted) return      // idempotent: the socket's error and close each fire once, only the first counts
    this.closeEmitted = true
    const wasOpen = this.open
    this.open = false
    try { if (this.sock) this.sock.destroy() } catch (e) { /* ignore */ }
    this.sock = null
    if (wasOpen || !this.closed) { if (this.onclose) { try { this.onclose() } catch (e) { /* ignore */ } } }
  }

  _frame(opcode, payload) {
    const len = payload.length
    let head
    if (len < 126) {
      head = Buffer.alloc(6)
      head[1] = 0x80 | len
    } else if (len < 65536) {
      head = Buffer.alloc(8)
      head[1] = 0x80 | 126
      head.writeUInt16BE(len, 2)
    } else {
      head = Buffer.alloc(14)
      head[1] = 0x80 | 127
      head.writeUInt32BE(0, 2)
      head.writeUInt32BE(len, 6)
    }
    head[0] = 0x80 | opcode
    const mask = randomBytes(4)
    mask.copy(head, head.length - 4)
    const out = Buffer.alloc(len)
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4]
    return Buffer.concat([head, out])
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    if (!this.handshaken) {
      const idx = this.buf.indexOf('\r\n\r\n')
      if (idx < 0) {
        if (this.buf.length > 65536) this._fail(new Error('handshake too large'))
        return
      }
      const head = this.buf.slice(0, idx).toString('latin1')
      this.buf = this.buf.slice(idx + 4)
      const headLines = head.split('\r\n')
      const status = headLines[0] || ''
      if (!/ 101\b/.test(status)) { this._fail(new Error('handshake failed: ' + status)); return }
      // RFC6455 requires the client to verify Sec-WebSocket-Accept = base64(SHA1(key + GUID)): without
      // that step an HTTP endpoint that merely "looks like" one (or a MITM) could fool the handshake.
      const hdrs = {}
      for (let i = 1; i < headLines.length; i++) {
        const j = headLines[i].indexOf(':')
        if (j > 0) hdrs[headLines[i].slice(0, j).trim().toLowerCase()] = headLines[i].slice(j + 1).trim()
      }
      const expect = createHash('sha1').update(this.wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      if (hdrs['sec-websocket-accept'] !== expect) {
        this._fail(new Error('handshake failed: Sec-WebSocket-Accept 不匹配'))
        return
      }
      this.handshaken = true
      this.open = true
      if (this.onopen) { try { this.onopen() } catch (e) { log('onopen threw', e && e.message) } }
    }
    // frame parsing
    for (;;) {
      if (this.buf.length < 2) return
      const b0 = this.buf[0]
      const b1 = this.buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (this.buf.length < off + 2) return
        len = this.buf.readUInt16BE(off); off += 2
      } else if (len === 127) {
        if (this.buf.length < off + 8) return
        const hi = this.buf.readUInt32BE(off)
        const lo = this.buf.readUInt32BE(off + 4)
        len = hi * 4294967296 + lo; off += 8
      }
      let mask = null
      if (masked) {
        if (this.buf.length < off + 4) return
        mask = this.buf.slice(off, off + 4); off += 4
      }
      if (this.buf.length < off + len) return
      let payload = this.buf.slice(off, off + len)
      this.buf = this.buf.slice(off + len)
      if (mask) {
        const p = Buffer.alloc(len)
        for (let i = 0; i < len; i++) p[i] = payload[i] ^ mask[i % 4]
        payload = p
      }
      if (opcode === 0x8) { this.close(); return }
      if (opcode === 0x9) { try { this.sock.write(this._frame(0xa, payload)) } catch (e) { /* ignore */ } ; continue }
      if (opcode === 0xa) { if (this.onpong) { try { this.onpong() } catch (e) { /* ignore */ } } ; continue }
      if (opcode === 0x0) {
        this.fragChunks.push(payload)
        if (fin) {
          const full = Buffer.concat(this.fragChunks)
          this.fragChunks = []
          if (this.fragOpcode === 0x1 && this.onmessage) { try { this.onmessage(full.toString('utf8')) } catch (e) { /* ignore */ } }
          this.fragOpcode = 0
        }
        continue
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) { this.fragOpcode = opcode; this.fragChunks = [payload]; continue }
        if (opcode === 0x1 && this.onmessage) { try { this.onmessage(payload.toString('utf8')) } catch (e) { /* ignore */ } }
        continue
      }
      // any other opcode is ignored
    }
  }
}

// ── XiaoYi channel ────────────────────────────────────────────────────────────

class XiaoYiChannel {
  constructor(opts) {
    this.ak = opts.ak || ''
    this.sk = opts.sk || ''
    this.agentId = opts.agentId || ''
    this.wsUrl = opts.wsUrl || DEFAULT_WS_URL
    this.ws = null
    this.connected = false
    this.reconnectAttempts = 0
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.stopped = true
    this.lastError = ''
    this.lastMessageAt = 0
    this.lastActivityAt = 0
    this.msgCount = 0
    this.onRequest = opts.onRequest || (() => {})
    this.onCancel = opts.onCancel || (() => {})
  }

  ready() {
    return Boolean(this.ak && this.sk && this.agentId)
  }

  start() {
    if (this.stopped === false) return { ok: true, already: true }
    if (!this.ready()) return { ok: false, error: '缺少 AK/SK/agentId' }
    this.stopped = false
    this._connect()
    return { ok: true }
  }

  stop() {
    this.stopped = true
    this._clearTimers()
    this.connected = false
    if (this.ws) { try { this.ws.close() } catch (e) { /* ignore */ } ; this.ws = null }
    return { ok: true }
  }

  status() {
    return {
      ready: this.ready(),
      connected: this.connected,
      stopped: this.stopped,
      agentId: this.agentId,
      akTail: this.ak ? this.ak.slice(-6) : '',
      wsUrl: this.wsUrl,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
      msgCount: this.msgCount,
    }
  }

  _clearTimers() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  _authHeaders() {
    const ts = String(Date.now())
    const sign = createHmac('sha256', this.sk).update(ts).digest('base64')
    return { 'x-access-key': this.ak, 'x-sign': sign, 'x-ts': ts, 'x-agent-id': this.agentId }
  }

  _connect() {
    if (this.stopped) return
    this._clearTimers()
    let ws
    try {
      ws = new MiniWS(this.wsUrl, this._authHeaders())
    } catch (e) {
      this.lastError = String((e && e.message) || e)
      this._scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return           // late event from an old connection, discard it
      this.connected = true
      this.reconnectAttempts = 0
      this.lastError = ''
      this.lastActivityAt = Date.now()
      log('已连上小艺服务器 ' + this.wsUrl)
      this._send({ msgType: 'clawd_bot_init', agentId: this.agentId })
      this.heartbeatTimer = setInterval(() => {
        if (this.ws !== ws || !this.connected) return
        // Heartbeat + liveness: still connected but nothing heard back for a long time (pongs included)
        // → treat it as a zombie and reconnect. A switch can fool TCP, but not "how long since we last heard back".
        const idle = Date.now() - (this.lastActivityAt || 0)
        if (idle > HEARTBEAT_MS * 3) {
          this.lastError = '连接假死 ' + Math.round(idle / 1000) + 's 没回音，主动重连'
          log(this.lastError)
          try { ws.close() } catch (e) { /* ignore */ }
          return
        }
        try { ws.ping() } catch (e) { /* ignore */ }
        this._send({ msgType: 'heartbeat', agentId: this.agentId, timestamp: Date.now() })
      }, HEARTBEAT_MS)
    }
    ws.onmessage = (text) => {
      if (this.ws !== ws) return           // message from an old connection, discard it
      this.lastActivityAt = Date.now()
      this._onMessage(text)
    }
    ws.onpong = () => { if (this.ws === ws) this.lastActivityAt = Date.now() }
    ws.onerror = (err) => {
      if (this.ws !== ws) return
      this.lastError = String((err && err.message) || err)
      log('连接出错: ' + this.lastError)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return           // no longer the current connection: don't touch state, don't trigger a reconnect
      if (this.connected) log('与小艺的连接断开')
      this.connected = false
      this.ws = null
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
      this._scheduleReconnect()
    }
    try { ws.connect() } catch (e) {
      this.lastError = String((e && e.message) || e)
      this._scheduleReconnect()
    }
  }

  _scheduleReconnect() {
    if (this.stopped) return
    if (this.reconnectTimer) return
    this.reconnectAttempts += 1
    const delay = Math.min(2000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)), 60000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._connect()
    }, delay)
  }

  _send(obj) {
    if (!this.ws || !this.connected) return false
    return this.ws.sendText(safeJson(obj))
  }

  _onMessage(text) {
    let msg
    try { msg = JSON.parse(text) } catch (e) { return }
    if (!msg || typeof msg !== 'object') return
    if (msg.agentId && msg.agentId !== this.agentId) return
    this.lastMessageAt = Date.now()

    // control messages
    if (msg.method === 'clearContext' || msg.method === 'clear_context' || msg.action === 'clear') {
      const sid = msg.sessionId || (msg.params && msg.params.sessionId) || ''
      this._sendJsonRpc(msg.id, { result: { status: { state: 'cleared' } } }, sid, msg.id)
      log('收到 clearContext，已回执', sid)
      return
    }
    if (msg.method === 'tasks/cancel' || msg.method === 'tasks_cancel' || msg.action === 'tasks/cancel') {
      const sid = msg.sessionId || (msg.params && msg.params.sessionId) || ''
      const taskId = msg.taskId || msg.id
      this._sendJsonRpc(msg.id, { result: { id: taskId, status: { state: 'canceled' } } }, sid, taskId)
      log('收到 tasks/cancel，已回执', taskId)
      try { this.onCancel({ sessionId: sid, taskId, id: msg.id }) } catch (e) { /* ignore */ }
      return
    }
    // A2A conversation request
    if (msg.jsonrpc === '2.0' && msg.method === 'message/stream' && msg.params && msg.params.message) {
      const sessionId = msg.params.sessionId || msg.sessionId || ''
      const taskId = msg.params.id || msg.id
      const messageId = msg.id
      const parts = Array.isArray(msg.params.message.parts) ? msg.params.message.parts : []
      const textParts = parts.filter((p) => p && p.kind === 'text' && typeof p.text === 'string').map((p) => p.text)
      const text = textParts.join('\n').trim()
      const fileParts = parts.filter((p) => p && p.kind === 'file')
      this.msgCount += 1
      log('收到小艺消息 session=' + sessionId + ' task=' + taskId + ' 文本长度=' + text.length + (fileParts.length ? ' 文件=' + fileParts.length : ''))
      // send the ack first: let the device side know the job has been accepted
      this.sendStatus(sessionId, taskId, messageId, '任务正在处理中，请稍后~', 'working', false)
      try {
        this.onRequest({ sessionId, taskId, messageId, text, parts, fileParts })
      } catch (e) {
        log('处理入站消息失败', e && e.message)
        this.sendArtifact(sessionId, taskId, messageId, '这边处理消息时出错了：' + String((e && e.message) || e), true)
      }
      return
    }
  }

  _sendJsonRpc(messageId, payload, sessionId, taskId) {
    const body = Object.assign({ jsonrpc: '2.0', id: messageId }, payload)
    return this._send({
      msgType: 'agent_response',
      agentId: this.agentId,
      sessionId: sessionId || '',
      taskId: taskId || messageId,
      msgDetail: safeJson(body),
    })
  }

  sendStatus(sessionId, taskId, messageId, text, state, final) {
    return this._sendJsonRpc(messageId, {
      result: {
        taskId,
        kind: 'status-update',
        final: !!final,
        status: { message: { role: 'agent', parts: [{ kind: 'text', text: String(text || '') }] }, state: state || 'working' },
      },
    }, sessionId, taskId)
  }

  sendArtifact(sessionId, taskId, messageId, text, final) {
    return this._sendJsonRpc(messageId, {
      result: {
        taskId,
        kind: 'artifact-update',
        append: false,
        lastChunk: true,
        final: !!final,
        artifact: { artifactId: uuid(), parts: [{ kind: 'text', text: String(text == null ? '' : text) }] },
      },
    }, sessionId, taskId)
  }

  // Outbound "online file/image": Part extension { url, filename, mediaType } (Huawei "Part structure definition")
  sendArtifactWithFiles(sessionId, taskId, messageId, caption, files, final) {
    const parts = []
    if (caption) parts.push({ kind: 'text', text: String(caption) })
    for (const f of files || []) parts.push({ url: f.url, filename: f.filename, mediaType: f.mediaType })
    return this._sendJsonRpc(messageId, {
      result: {
        taskId,
        kind: 'artifact-update',
        append: false,
        lastChunk: true,
        final: !!final,
        artifact: { artifactId: uuid(), parts },
      },
    }, sessionId, taskId)
  }
}

// ── Inbound attachment download (XiaoYi → us) ────────────────────────────────
//
// Shape of an inbound A2A file part (per Huawei's "message stream" doc, matching the reference implementation):
//   { kind: 'file', file: { name, mimeType, uri } }
// Approach: fetch the uri and store it under ~/.dsh/xiaoyi/media/, then put the local path plus a
// note into the session text, so the agent inside the session can read_image / read it directly.

function safeFileName(name) {
  const base = String(name || ('file-' + Date.now())).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '')
  return base.slice(0, 120) || ('file-' + Date.now())
}

const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp', 'image/heic': '.heic', 'image/svg+xml': '.svg',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md',
  'application/json': '.json', 'application/zip': '.zip',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/amr': '.amr', 'audio/aac': '.aac',
  'video/mp4': '.mp4',
}

// ── Security gate for inbound URIs (SSRF protection) ─────────────────────────
//
// The uri of an inbound file part comes from **external messages** — untrusted input — so it can't be fetched blindly:
//   1) Only http/https is allowed (blocks file:, data: and friends)
//   2) Loopback / private / link-local addresses are blocked — otherwise it could be used as a springboard
//      to probe the intranet, or even to read a cloud environment's metadata service (169.254.169.254)
//   3) After a redirect, check again: a public address 302-ing to 127.0.0.1 is the most common bypass trick

function isPrivateIp(ip) {
  const v = String(ip || '')
  if (net.isIPv4(v)) {
    const p = v.split('.').map(Number)
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
    if (p[0] === 192 && p[1] === 168) return true
    if (p[0] === 169 && p[1] === 254) return true                 // link-local (cloud metadata)
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true    // carrier-grade CGNAT
    if (p[0] >= 224) return true                                  // multicast / reserved ranges
    return false
  }
  if (net.isIPv6(v)) {
    const s = v.toLowerCase()
    if (s === '::' || s === '::1') return true
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true
    if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7))   // IPv4-mapped
    return false
  }
  return false
}

function checkInboundUri(uri) {
  let u
  try { u = new URL(String(uri)) } catch (e) { return '不是合法的 URL' }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只允许 http/https 链接（收到 ' + u.protocol + '）'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^(localhost|.+\.local|.+\.internal|.+\.localhost)$/i.test(host)) return '拒绝访问本机/内网地址：' + host
  if (net.isIP(host) && isPrivateIp(host)) return '拒绝访问内网地址：' + host
  return ''
}

// Stream the body under a hard cap: trusting content-length alone lets an under-reporting response blow up memory
async function readBodyCapped(res, max) {
  const tooBig = (n) => new Error('文件太大：' + (n / 1048576).toFixed(1) + ' MB（上限 ' + (max / 1048576) + ' MB）')
  if (!res.body || typeof res.body.getReader !== 'function') {
    const b = Buffer.from(await res.arrayBuffer())
    if (b.length > max) throw tooBig(b.length)
    return b
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    total += step.value.length
    if (total > max) { try { await reader.cancel() } catch (e) { /* ignore */ } ; throw tooBig(total) }
    chunks.push(Buffer.from(step.value))
  }
  return Buffer.concat(chunks)
}

async function downloadInboundFiles(fileParts) {
  const dir = join(homedir(), '.dsh', 'xiaoyi', 'media')
  const out = []
  try { mkdirSync(dir, { recursive: true }) } catch (e) { /* ignore */ }
  for (const part of fileParts || []) {
    const f = (part && part.file) || {}
    const uri = String(f.uri || '')
    const rawName = String(f.name || f.fileName || '')
    const mime = String(f.mimeType || '')
    if (!uri) { out.push({ ok: false, name: rawName, mimeType: mime, error: '没有 uri' }); continue }
    const risky = checkInboundUri(uri)
    if (risky) {
      out.push({ ok: false, name: rawName, mimeType: mime, uri, error: risky })
      log('拒绝下载附件：' + risky + ' uri=' + uri.slice(0, 120))
      continue
    }
    let name = safeFileName(rawName || ('file-' + Date.now()))
    if (!/\.[A-Za-z0-9]{1,5}$/.test(name) && MIME_EXT[mime.toLowerCase()]) name += MIME_EXT[mime.toLowerCase()]
    const dest = join(dir, Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '_' + name)
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 60000)
      let res
      try {
        res = await fetch(uri, { signal: ctl.signal, headers: { 'User-Agent': 'dsh-xiaoyi/0.1' } })
      } finally { clearTimeout(timer) }
      if (!res.ok) throw new Error('HTTP ' + res.status)
      // re-check where we landed after redirects: a public link 302-ing to 127.0.0.1 is a classic bypass
      const landed = checkInboundUri(res.url || uri)
      if (landed) throw new Error('重定向到不可信地址：' + landed)
      // size gate: don't let one huge attachment fill up the disk (50 MB cap by default)
      const MAX_INBOUND = 50 * 1024 * 1024
      const declared = Number(res.headers.get('content-length') || 0)
      if (declared && declared > MAX_INBOUND) {
        throw new Error('文件太大：' + (declared / 1048576).toFixed(1) + ' MB（上限 50 MB）')
      }
      const buf = await readBodyCapped(res, MAX_INBOUND)
      writeFileSync(dest, buf)
      out.push({ ok: true, path: dest, name: rawName || name, mimeType: mime || res.headers.get('content-type') || '', bytes: buf.length })
      log('已下载小艺附件 → ' + dest + '（' + buf.length + ' 字节）')
    } catch (e) {
      const err = String((e && e.message) || e)
      out.push({ ok: false, name: rawName || name, mimeType: mime, uri, error: err })
      log('下载小艺附件失败：' + err + ' uri=' + uri.slice(0, 120))
    }
  }
  return out
}

// ── Publishing outbound "online file/image" (us → XiaoYi) ────────────────────
//
// The protocol requires files sent back to the device side to be **public https URLs**
// (Part extension: url + filename + mediaType). Three publishing modes:
//   local  —— copy into ~/.dsh/xiaoyi/public/, serve via the plugin's own HTTP route, and pair it with a
//             tunnel (e.g. localhost.run) pointed at by state.publicBaseUrl: the file never leaves the box
//   catbox —— upload to catbox.moe (third-party image host; one request gets an https link)
//   none   —— don't publish, just fail with a clear error

const EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.pdf': 'application/pdf',
  '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/plain', '.json': 'text/plain',
}

function mimeOfName(name) {
  const m = String(name || '').toLowerCase().match(/\.[a-z0-9]{1,5}$/)
  return (m && EXT_MIME[m[0]]) || 'application/octet-stream'
}

function publicDir() {
  const d = join(homedir(), '.dsh', 'xiaoyi', 'public')
  try { mkdirSync(d, { recursive: true }) } catch (e) { /* ignore */ }
  return d
}

function copyToPublic(filePath) {
  const name = safeFileName(require$basename(filePath))
  // a public link must be unguessable: with a bare timestamp, anyone could enumerate by time and sweep up every file sent
  const dest = join(publicDir(), Date.now().toString(36) + '-' + randomBytes(8).toString('hex') + '-' + name)
  writeFileSync(dest, readFileSync(filePath))
  return { dest, name, mediaType: mimeOfName(name) }
}

async function uploadToCatbox(filePath) {
  const name = require$basename(filePath)
  const buf = readFileSync(filePath)
  const fd = new FormData()
  fd.append('reqtype', 'fileupload')
  fd.append('fileToUpload', new Blob([buf]), name)
  const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd })
  const text = (await res.text()).trim()
  if (!/^https?:\/\//.test(text)) throw new Error('catbox 返回异常：' + text.slice(0, 200))
  return { url: text, filename: name, mediaType: mimeOfName(name) }
}

function require$basename(p) {
  const s = String(p || '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}

// ── Reply text extraction (visible body only, skipping reasoning) ─────────────

function extractReplyText(msg) {
  if (!msg) return ''
  try {
    const c = msg.content
    if (typeof c === 'string') return c.trim()
    if (Array.isArray(c)) {
      const parts = []
      for (const b of c) {
        if (!b) continue
        if (typeof b === 'string') { parts.push(b); continue }
        if (b.type === 'reasoning') continue
        if (typeof b.text === 'string' && b.text) parts.push(b.text)
      }
      return parts.join('\n').trim()
    }
  } catch (e) { /* ignore */ }
  return ''
}

function hasToolCalls(msg) {
  if (!msg) return false
  try {
    const c = msg.content
    if (!Array.isArray(c)) return false
    for (const b of c) if (b && typeof b === 'object' && b.type === 'tool-call') return true
  } catch (e) { /* ignore */ }
  return false
}

// Used by the offline self-test scripts (not part of plugin loading)
export { MiniWS, XiaoYiChannel, extractReplyText, hasToolCalls, checkInboundUri, isPrivateIp }

// ── Plugin body ──────────────────────────────────────────────────────────────

export function apply(ctx) {
  const state = loadState()
  if (typeof state.enabled !== 'boolean') state.enabled = true
  if (!state.wsUrl) state.wsUrl = DEFAULT_WS_URL

  let listenHandle = null
  let listenPromise = null    // session initialisation currently in flight (shared by concurrent callers, avoids a false "not ready")
  let pending = []            // queue of XiaoYi requests awaiting a reply (FIFO): the reply always targets the head
  let currentReply = ''       // most recent chunk of body text in this turn

  const channel = new XiaoYiChannel({
    ak: state.ak,
    sk: state.sk,
    agentId: state.agentId,
    wsUrl: state.wsUrl,
    onRequest: (req) => {
      pending.push(req)
      void (async () => {
        try {
          await ensureListen()
          const h = listenHandle
          if (!h) {
            channel.sendArtifact(req.sessionId, req.taskId, req.messageId, '我这边还没起来（DSH 会话未就绪），请稍后再试。', true)
            pending = pending.filter((p) => p !== req)
            return
          }
          // Inbound attachments: fetch them locally first, then hand the paths to the agent in the session
          let files = []
          if (req.fileParts && req.fileParts.length) {
            log('入站 parts 原文：' + safeJson(req.parts).slice(0, 1200))
            files = await downloadInboundFiles(req.fileParts)
          }
          let text = '【小艺】' + (req.text || '')
          if (files.length) {
            const okList = files.filter((f) => f.ok)
            const badList = files.filter((f) => !f.ok)
            if (okList.length) {
              text += '\n\n附件已下载到本地（可用 read_image / read 工具查看）：\n'
                + okList.map((f) => '- ' + f.path + '（' + (f.mimeType || '未知类型') + '，' + f.bytes + ' 字节，原名 ' + f.name + '）').join('\n')
            }
            if (badList.length) {
              text += '\n\n以下附件没抓下来：\n' + badList.map((f) => '- ' + f.name + '（' + f.error + '）').join('\n')
            }
          }
          // Note: this deliberately does **not** touch currentReply and does not claim "active"—— several messages
          // may queue up, and replies always go to the head (shift in finishTurn); otherwise the second one would
          // clobber the first one's body and attach the reply frame to the wrong taskId.
          //
          // We must also catch failures of followup: Node treats an "unhandled promise rejection" as fatal by default,
          // and one uncaught rejection can take the whole host process down — so still reply and dequeue on failure.
          const followed = h.agent.followup({
            id: 'xy-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'plugin:dsh-xiaoyi' },
          })
          Promise.resolve(followed).catch((e) => {
            log('投递会话失败', e && e.message)
            channel.sendArtifact(req.sessionId, req.taskId, req.messageId, '把消息投递给 DSH 会话时出错了：' + String((e && e.message) || e), true)
            pending = pending.filter((p) => p !== req)
          })
        } catch (e) {
          log('处理小艺请求失败', e && e.message)
          channel.sendArtifact(req.sessionId, req.taskId, req.messageId, '处理这条消息时出错了：' + String((e && e.message) || e), true)
          pending = pending.filter((p) => p !== req)
        }
      })()
    },
    onCancel: (info) => {
      // the device side hit "stop": drop this task from the reply queue so we don't later reply to a cancelled task
      const before = pending.length
      pending = pending.filter((p) => !(p.taskId === info.taskId || p.messageId === info.taskId || p.taskId === info.id))
      if (pending.length !== before) log('已从待回复队列移除被取消的任务（剩 ' + pending.length + ' 条）')
      currentReply = ''
    },
  })

  // ── DSH session (reuse the same one across cold starts, never open a duplicate conversation) ──

  function findLatestListenSessionId() {
    try {
      const root = join(homedir(), '.dsh', 'sessions')
      // Only accept the bucket whose cwd is right (DSH encodes cwd in dir names like `--C-Users-Alice-Desktop--`)
      const wantCwd = String(state.cwd || join(homedir(), 'Desktop'))
      // DSH's workspace directory naming rule: drop the drive-letter colon, turn `\` and `/` into `-`.
      // Example: C:\Users\Alice\Desktop → --C-Users-Alice-Desktop--
      const wantTag = '--' + wantCwd.replace(/:/g, '').replace(/[\\/]/g, '-') + '--'
      let best = ''
      let bestTime = 0
      for (const ws of readdirSync(root)) {
        if (ws !== wantTag) continue
        let entries
        try { entries = readdirSync(join(root, ws)) } catch (e) { continue }
        for (const nm of entries) {
          if (nm.indexOf('xiaoyi-listen-') !== 0) continue
          // The session file format changes across host upgrades (v3 → v4). Pinning a single version
          // name would make upgraded sessions "invisible", so every cold start would open a new conversation.
          let mtime = 0
          for (const fname of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
            try {
              const st = statSync(join(root, ws, nm, fname))
              if (st.mtimeMs > mtime) mtime = st.mtimeMs
            } catch (e) { /* this version's file doesn't exist, try the next one */ }
          }
          if (mtime > bestTime) { bestTime = mtime; best = nm }
        }
      }
      return best
    } catch (e) { return '' }
  }

  async function doEnsureListen() {
    try {
      const agents = ctx.get('agents')
      if (!agents || typeof agents.create !== 'function') { log('agents 服务不可用'); return null }
      let model = { provider: '', model: '' }
      const adm = ctx.get('agentDefaultModel')
      if (adm && typeof adm.currentSelection === 'function') {
        try { model = adm.currentSelection() || model } catch (e) { /* ignore */ }
      }
      if (!model.provider || !model.model) { log('未配置默认模型'); return null }
      let setup
      const presets = ctx.get('agentPresets')
      if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
        try {
          const resolved = await presets.resolve(undefined)
          const presetId = resolved && resolved.id
          if (presetId) setup = async (agentCtx) => { await presets.mount(agentCtx, presetId) }
        } catch (e) { /* ignore */ }
      }
      // Try resume first: prefer the session remembered in state, so we open as few new conversations as possible
      async function tryResume(id) {
        if (!id || typeof agents.resume !== 'function') return null
        if (typeof agents.get === 'function') {
          try {
            const live = agents.get(id)
            if (live && live.agent) { log('会话 ' + id + ' 已在本进程里活着，直接复用'); return live }
          } catch (e) { /* ignore */ }
        }
        const o = { resumeSessionId: id }
        if (setup) o.setup = setup
        if (model.provider && model.model) o.agentOptions = { provider: model.provider, model: model.model }
        try {
          const h = await agents.resume(o)
          log('已复用会话 ' + id)
          return h
        } catch (e) {
          log('resume ' + id + ' 失败：' + String((e && e.message) || e))
          return null
        }
      }
      let storedId = String(state.sessionId || '')
      if (!storedId) {
        storedId = findLatestListenSessionId()
        if (storedId) log('从磁盘找回会话 ' + storedId)
      }
      let handle = await tryResume(storedId)
      if (!handle) {
        const alt = findLatestListenSessionId()
        if (alt && alt !== storedId) handle = await tryResume(alt)
      }
      if (handle) {
        listenHandle = handle
        try {
          if (handle.agent && handle.agent.id) { state.sessionId = handle.agent.id; saveState(state) }
        } catch (e) { /* ignore */ }
        return handle
      }
      const sessionId = 'xiaoyi-listen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      // The working directory must be writable: if the host was started from a system directory, the session
      // sandbox (workspace-write) cannot even create temp files, leaving the session unable to do anything.
      const cwd = String(state.cwd || join(homedir(), 'Desktop'))
      const opts = { sessionId, meta: { cwd }, agentOptions: { provider: model.provider, model: model.model } }
      if (setup) opts.setup = setup
      const created = await agents.create(opts)
      listenHandle = created
      if (created && created.agent && created.agent.id) {
        state.sessionId = created.agent.id
        state.cwd = cwd
        saveState(state)
        log('已新建会话 ' + created.agent.id + '（工作目录 ' + cwd + '）')
      }
      return created
    } catch (e) {
      log('ensureListen 异常', e && e.message)
      return null
    }
  }

  // Concurrency guard: several XiaoYi messages may arrive at once. The old code returned null as soon as
  // the second one saw "initialising", so users got a **false failure** ("DSH session not ready"). Now the Promise is shared.
  function ensureListen() {
    if (listenHandle) return Promise.resolve(listenHandle)
    if (listenPromise) return listenPromise
    const p = doEnsureListen()
    listenPromise = p
    const clear = () => { if (listenPromise === p) listenPromise = null }
    p.then(clear, clear)
    return p
  }

  // ── Send the reply back to XiaoYi ────────────────────────────────────────────

  function finishTurn(reason) {
    // Replies always target the queue head: turns in a DSH session are queued one by one, first asked first answered.
    const req = pending[0]
    const text = currentReply
    if (!req) { currentReply = ''; return }
    currentReply = ''
    pending.shift()
    const out = String(text || '').trim()
    if (!out) { log('本回合没有可见正文（' + reason + '），不回帧'); return }
    // As in the reference implementation: send a "completed" status frame first, then the artifact-update body (final=true)
    channel.sendStatus(req.sessionId, req.taskId, req.messageId, '任务处理已完成~', 'completed', false)
    channel.sendArtifact(req.sessionId, req.taskId, req.messageId, out, true)
    log('已回小艺（' + reason + '）长度=' + out.length + '，队列剩 ' + pending.length)
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'assistant/message') return
      if (!listenHandle || !session || session.id !== listenHandle.agent.id) return
      const msg = event.data && event.data.message
      const t = extractReplyText(msg)
      if (!t) return
      currentReply = t
      if (!hasToolCalls(msg)) finishTurn('assistant-final')
    } catch (e) { /* ignore */ }
  })

  ctx.on('agent/status', (payload) => {
    try {
      if (!payload || payload.status !== 'idle') return
      if (!listenHandle || payload.agent !== listenHandle.agent) return
      if (pending.length && currentReply) finishTurn('idle')
    } catch (e) { /* ignore */ }
  })

  // ── agent tools (each one must carry output, otherwise the whole plugin tree fails to load) ──

  const outSchema = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }

  ctx.effect(() => ctx.tools.register({
    name: 'xiaoyi_status',
    description: 'Report the XiaoYi (小艺) channel state: whether AK/SK/agentId are configured, whether the WebSocket to Huawei cloud is connected, the listen session id, last error and message counters.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: outSchema,
    async execute() {
      return Object.assign({ ok: true }, channel.status(), {
        listening: Boolean(listenHandle),
        listenSessionId: listenHandle ? listenHandle.agent.id : (state.sessionId || null),
        queued: pending.length,
      })
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'xiaoyi_set',
    description: 'Set or update the XiaoYi channel credentials/switch (AK, SK, agentId, wsUrl, enabled). Call with the fields you want to change. Takes effect immediately on the live WebSocket connection.',
    parameters: {
      type: 'object',
      properties: {
        ak: { type: 'string', description: 'Access Key from 小艺开放平台凭证' },
        sk: { type: 'string', description: 'Secret Key from 小艺开放平台凭证' },
        agentId: { type: 'string', description: 'OpenClaw 模式智能体的 agentId' },
        wsUrl: { type: 'string', description: 'WebSocket 地址，默认 wss://hag.cloud.huawei.com/openclaw/v1/ws/link' },
        enabled: { type: 'boolean', description: '是否启用（false 会断开连接）' },
      },
      required: [],
    },
    output: outSchema,
    async execute(args) {
      const a = args && typeof args === 'object' ? args : {}
      if (typeof a.ak === 'string' && a.ak.trim()) { state.ak = a.ak.trim(); channel.ak = state.ak }
      if (typeof a.sk === 'string' && a.sk.trim()) { state.sk = a.sk.trim(); channel.sk = state.sk }
      if (typeof a.agentId === 'string' && a.agentId.trim()) { state.agentId = a.agentId.trim(); channel.agentId = state.agentId }
      if (typeof a.wsUrl === 'string' && a.wsUrl.trim()) { state.wsUrl = a.wsUrl.trim(); channel.wsUrl = state.wsUrl }
      if (typeof a.enabled === 'boolean') state.enabled = a.enabled
      saveState(state)
      channel.stop()
      if (state.enabled && channel.ready()) channel.start()
      return Object.assign({ ok: true }, channel.status())
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'xiaoyi_send',
    description: 'Proactively push a short text message to the current 小艺 conversation (only works while a 小艺 task is active). Use it when a long task finishes and the user is waiting on the phone.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要发到小艺的短文本（一句话以内）' } },
      required: ['text'],
    },
    output: outSchema,
    async execute(args) {
      const text = String((args && args.text) || '').trim()
      if (!text) return { ok: false, error: 'text 为空' }
      const req = pending[0]
      if (!req) return { ok: false, error: '当前没有进行中的小艺会话' }
      const sent = channel.sendStatus(req.sessionId, req.taskId, req.messageId, text, 'working', false)
      return { ok: Boolean(sent), sessionId: req.sessionId, taskId: req.taskId }
    },
  }))

  // Outbound images/files: turn a local file into a public https link and send it back to XiaoYi
  const pubRoutes = new Set()
  function registerPublicRoute(name) {
    if (pubRoutes.has(name)) return
    pubRoutes.add(name)
    const p = '/xiaoyi/public/' + name
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: p,
      handler: async (_req, res) => {
        try {
          const buf = readFileSync(join(publicDir(), name))
          res.writeHead(200, { 'content-type': mimeOfName(name), 'cache-control': 'public, max-age=600' })
          res.end(buf)
        } catch (e) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
        }
      },
    }), 'xiaoyi: pub ' + name)
  }

  ctx.effect(() => ctx.tools.register({
    name: 'xiaoyi_send_photo',
    description: 'Send a local image or file to the current 小艺 conversation as an online file. The 小艺 protocol only accepts public https URLs for outbound files, so the file is either served locally (mode=local, needs a configured publicBaseUrl + tunnel) or uploaded to catbox.moe (mode=catbox, third-party host, must be requested explicitly). Requires an active 小艺 task.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '本地文件的绝对路径（图片推荐 png/jpg/gif/webp/bmp）' },
        caption: { type: 'string', description: '随文件一起发的说明文字（可省）' },
        mode: { type: 'string', description: 'local=本机起路由+隧道（文件不出门，默认）；catbox=上传第三方图床 catbox.moe（必须显式指定）' },
      },
      required: ['filePath'],
    },
    output: outSchema,
    async execute(args) {
      const a = args && typeof args === 'object' ? args : {}
      const filePath = String(a.filePath || '')
      if (!filePath || !existsSync(filePath)) return { ok: false, error: '文件不存在：' + filePath }
      const req = pending[0]
      if (!req) return { ok: false, error: '当前没有进行中的小艺会话（得先在小艺里说句话）' }
      // Privacy first: default to local-only (the file never leaves this machine). Uploading to a third-party
      // image host must be enabled **explicitly** (pass mode="catbox", or set "imageHost": "catbox" in state.json).
      // Older versions silently fell back to catbox with no tunnel, and the user never knew their file was uploaded.
      const mode = String(a.mode || state.imageHost || 'local')
      let file = null
      try {
        if (mode === 'local') {
          const base = String(state.publicBaseUrl || '').replace(/\/+$/, '')
          if (!base) return { ok: false, error: '没配 publicBaseUrl：本机模式需要一条隧道（如 localhost.run）把 DSH 的端口暴露成公网 https；不想用隧道就显式传 mode="catbox"（会把文件上传到第三方图床 catbox.moe）' }
          const c = copyToPublic(filePath)
          registerPublicRoute(require$basename(c.dest))
          file = { url: base + '/xiaoyi/public/' + require$basename(c.dest), filename: c.name, mediaType: c.mediaType }
        } else if (mode === 'catbox') {
          file = await uploadToCatbox(filePath)
        } else {
          return { ok: false, error: '不支持的 mode：' + mode }
        }
        const sent = channel.sendArtifactWithFiles(req.sessionId, req.taskId, req.messageId, a.caption || '', [file], true)
        log('已向小艺发送文件 url=' + file.url)
        return { ok: Boolean(sent), mode, file }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'xiaoyi_reconnect',
    description: 'Force the XiaoYi channel to drop and re-establish the WebSocket connection to Huawei cloud (useful after changing credentials or when the link looks stale).',
    parameters: { type: 'object', properties: {}, required: [] },
    output: outSchema,
    async execute() {
      channel.stop()
      if (!channel.ready()) return { ok: false, error: '缺少 AK/SK/agentId' }
      channel.start()
      return { ok: true, status: channel.status() }
    },
  }))

  // ── HTTP routes (for browsers/scripts to read status) ────────────────────────

  function sendJson(res, status, obj) {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    } catch (e) { /* ignore */ }
  }

  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), 'xiaoyi: ' + path)

  route('/xiaoyi/state', async (_req, res) => {
    sendJson(res, 200, Object.assign({ ok: true }, channel.status(), {
      enabled: Boolean(state.enabled),
      listening: Boolean(listenHandle),
      listenSessionId: listenHandle ? listenHandle.agent.id : (state.sessionId || null),
      queued: pending.length,
    }))
  })

  route('/xiaoyi/connect', async (_req, res) => {
    if (!channel.ready()) { sendJson(res, 400, { ok: false, error: '缺少 AK/SK/agentId' }); return }
    state.enabled = true
    saveState(state)
    channel.stop()
    channel.start()
    void ensureListen()
    sendJson(res, 200, { ok: true, status: channel.status() })
  })

  route('/xiaoyi/disconnect', async (_req, res) => {
    channel.stop()
    sendJson(res, 200, { ok: true, status: channel.status() })
  })

  // ── Startup / teardown ───────────────────────────────────────────────────────

  ctx.effect(() => {
    if (state.enabled && channel.ready()) {
      channel.start()
      void ensureListen()
      log('插件已加载：通道已启动（agentId=' + state.agentId + '）')
    } else {
      log('插件已加载：未启用或缺凭证（ak=' + (state.ak ? '有' : '无') + ' sk=' + (state.sk ? '有' : '无') + ' agentId=' + (state.agentId ? '有' : '无') + '）')
    }
    return () => {
      try { channel.stop() } catch (e) { /* ignore */ }
    }
  }, 'xiaoyi: channel')

  log('dsh-xiaoyi apply() 完成')
}
