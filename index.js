// dsh-xiaoyi —— 小艺通道（把「小艺开放平台 · OpenClaw 模式」接进 DSH，当一只手用）
//
// 链路：手机小艺 →（华为云 wss 长连接）→ 本插件 → DSH 会话（DSH）→ 回复按 A2A 帧发回小艺
//
// 设计原则
//  1) 只依赖 node 内置模块（含自研极简 WebSocket 客户端），不引第三方包：
//     插件树里少一个包，就少一次「加载失败→整个宿主起不来」的风险。
//  2) 所有 ctx.tools.register 都带 output{schema,render}（缺了会拖垮整棵插件树）。
//  3) 任何连接动作都 try/catch 包住，绝不让 apply() 抛错。
//
// 协议要点（照 @ynhcj/xiaoyi 0.0.8-beta 的 dist 逐行核对过）
//   连接地址：wss://hag.cloud.huawei.com/openclaw/v1/ws/link
//   鉴权请求头：x-access-key=AK / x-sign=Base64(HMAC-SHA256(SK, ts)) / x-ts=毫秒 / x-agent-id=agentId
//   握手：{"msgType":"clawd_bot_init","agentId":"..."}
//   心跳：每 30s {"msgType":"heartbeat","agentId":"...","timestamp":...}（同时发协议层 ping）
//   入站：JSON-RPC 2.0，method="message/stream"，sessionId=params.sessionId，
//         taskId=params.id，messageId=顶层 id，文本在 params.message.parts[kind=text].text
//   出站：{"msgType":"agent_response", agentId, sessionId, taskId, msgDetail:"<JSON-RPC 字符串>"}
//         msgDetail.result.kind = "status-update"（state=working，先回执）
//                                 "artifact-update"（正文，lastChunk=true, final=true 收尾）
//   控制：method="clearContext" / "tasks/cancel" / action="clear" → 回对应 JSON-RPC response

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { randomBytes, createHmac } from 'node:crypto'
import tls from 'node:tls'
import net from 'node:net'

export const name = 'dsh-xiaoyi'
export const inject = ['tools', 'webServer']

const DEFAULT_WS_URL = 'wss://hag.cloud.huawei.com/openclaw/v1/ws/link'
const STATE_DIR = join(homedir(), '.dsh', 'xiaoyi')
const STATE_FILE = join(STATE_DIR, 'state.json')
const LOG_FILE = join(STATE_DIR, 'xiaoyi.log')
const HEARTBEAT_MS = 30000

// ── 小工具 ────────────────────────────────────────────────────────────────────

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

// ── 极简 WebSocket 客户端（RFC6455 客户端侧，够用即止） ────────────────────────
//
// 只做我们需要的：文本帧收发、ping/pong、close、分片重组（continuation）。

class MiniWS {
  constructor(url, headers) {
    this.url = url
    this.headers = headers || {}
    this.sock = null
    this.buf = Buffer.alloc(0)
    this.handshaken = false
    this.open = false
    this.closed = false
    this.fragOpcode = 0
    this.fragChunks = []
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
  }

  connect() {
    let u
    try { u = new URL(this.url) } catch (e) { this._fail(e); return }
    const port = u.port ? Number(u.port) : (u.protocol === 'wss:' ? 443 : 80)
    const key = randomBytes(16).toString('base64')
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
      const status = head.split('\r\n')[0] || ''
      if (!/ 101\b/.test(status)) { this._fail(new Error('handshake failed: ' + status)); return }
      this.handshaken = true
      this.open = true
      if (this.onopen) { try { this.onopen() } catch (e) { log('onopen threw', e && e.message) } }
    }
    // 帧解析
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
      if (opcode === 0xa) { continue }
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
      // 其它 opcode 忽略
    }
  }
}

// ── 小艺通道 ──────────────────────────────────────────────────────────────────

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
    this.msgCount = 0
    this.onRequest = opts.onRequest || (() => {})
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
      this.connected = true
      this.reconnectAttempts = 0
      this.lastError = ''
      log('已连上小艺服务器 ' + this.wsUrl)
      this._send({ msgType: 'clawd_bot_init', agentId: this.agentId })
      this.heartbeatTimer = setInterval(() => {
        if (!this.connected) return
        try { this.ws.ping() } catch (e) { /* ignore */ }
        this._send({ msgType: 'heartbeat', agentId: this.agentId, timestamp: Date.now() })
      }, HEARTBEAT_MS)
    }
    ws.onmessage = (text) => this._onMessage(text)
    ws.onerror = (err) => {
      this.lastError = String((err && err.message) || err)
      log('连接出错: ' + this.lastError)
    }
    ws.onclose = () => {
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

    // 控制类
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
      return
    }
    // A2A 对话请求
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
      // 先回执：让端上知道活儿接了
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
}

// ── 回复文本提取（只取可见正文，跳过 reasoning） ───────────────────────────────

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

// 供离线自测脚本使用（不参与插件加载）
export { MiniWS, XiaoYiChannel, extractReplyText, hasToolCalls }

// ── 插件主体 ──────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const state = loadState()
  if (typeof state.enabled !== 'boolean') state.enabled = true
  if (!state.wsUrl) state.wsUrl = DEFAULT_WS_URL

  let listenHandle = null
  let listenStarting = false
  let pending = []            // 待回复的小艺请求队列（FIFO）
  let currentReply = ''       // 本回合最近一段正文
  let active = null           // 正在处理的那条请求

  const channel = new XiaoYiChannel({
    ak: state.ak,
    sk: state.sk,
    agentId: state.agentId,
    wsUrl: state.wsUrl,
    onRequest: (req) => {
      pending.push(req)
      ensureListen().then(() => {
        const h = listenHandle
        if (!h) {
          channel.sendArtifact(req.sessionId, req.taskId, req.messageId, '我这边还没起来（DSH 会话未就绪），请稍后再试。', true)
          pending = pending.filter((p) => p !== req)
          return
        }
        const files = (req.fileParts || []).map((p) => (p.file && (p.file.uri || p.file.name)) || '').filter(Boolean)
        let text = '【小艺】' + (req.text || '')
        if (files.length) text += '\n\n附带文件（如需下载请告诉我）：\n' + files.map((f) => '- ' + f).join('\n')
        currentReply = ''
        active = req
        try {
          h.agent.followup({
            id: 'xy-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: 'dsh-xiaoyi' },
          })
        } catch (e) {
          log('followup 失败', e && e.message)
          channel.sendArtifact(req.sessionId, req.taskId, req.messageId, '投递到 DSH 会话失败：' + String((e && e.message) || e), true)
          pending = pending.filter((p) => p !== req)
          if (active === req) active = null
        }
      }).catch((e) => {
        log('ensureListen 失败', e && e.message)
        channel.sendArtifact(req.sessionId, req.taskId, req.messageId, 'DSH 会话准备失败：' + String((e && e.message) || e), true)
        pending = pending.filter((p) => p !== req)
      })
    },
  })

  // ── DSH 会话（冷启动复用同一条，不重复新开对话） ──────────────────────

  function findLatestListenSessionId() {
    try {
      const root = join(homedir(), '.dsh', 'sessions')
      let best = ''
      let bestTime = 0
      for (const ws of readdirSync(root)) {
        let entries
        try { entries = readdirSync(join(root, ws)) } catch (e) { continue }
        for (const nm of entries) {
          if (nm.indexOf('xiaoyi-listen-') !== 0) continue
          try {
            const st = statSync(join(root, ws, nm, 'session.v3.jsonl.zstd'))
            if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = nm }
          } catch (e) { /* 没有会话文件 */ }
        }
      }
      return best
    } catch (e) { return '' }
  }

  async function ensureListen() {
    if (listenHandle) return listenHandle
    if (listenStarting) return null
    listenStarting = true
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
      // 先尝试 resume
      let storedId = String(state.sessionId || '')
      if (!storedId) {
        storedId = findLatestListenSessionId()
        if (storedId) log('从磁盘找回会话 ' + storedId)
      }
      if (storedId && typeof agents.resume === 'function') {
        let alive = false
        if (typeof agents.get === 'function') {
          try { alive = Boolean(agents.get(storedId)) } catch (e) { /* ignore */ }
        }
        if (alive) {
          log('会话 ' + storedId + ' 已在本进程里活着，不再 resume')
        } else {
          const opts = { resumeSessionId: storedId }
          if (setup) opts.setup = setup
          if (model.provider && model.model) opts.agentOptions = { provider: model.provider, model: model.model }
          try {
            const resumed = await agents.resume(opts)
            listenHandle = resumed
            log('已复用会话 ' + storedId)
            return resumed
          } catch (e) {
            log('resume ' + storedId + ' 失败，改为新建', e && e.message)
          }
        }
      }
      const sessionId = 'xiaoyi-listen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      const opts = { sessionId, meta: { cwd: process.cwd() }, agentOptions: { provider: model.provider, model: model.model } }
      if (setup) opts.setup = setup
      const created = await agents.create(opts)
      listenHandle = created
      if (created && created.agent && created.agent.id) {
        state.sessionId = created.agent.id
        saveState(state)
        log('已新建会话 ' + created.agent.id)
      }
      return created
    } catch (e) {
      log('ensureListen 异常', e && e.message)
      return null
    } finally {
      listenStarting = false
    }
  }

  // ── 回复回传小艺 ──────────────────────────────────────────────────────────

  function finishTurn(reason) {
    const req = active
    const text = currentReply
    if (!req) { currentReply = ''; return }
    active = null
    currentReply = ''
    pending = pending.filter((p) => p !== req)
    const out = String(text || '').trim()
    if (!out) return
    channel.sendArtifact(req.sessionId, req.taskId, req.messageId, out, true)
    log('已回小艺（' + reason + '）长度=' + out.length)
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
      if (active) finishTurn('idle')
    } catch (e) { /* ignore */ }
  })

  // ── agent 工具（每个都必须带 output，否则整棵插件树加载失败） ──────────────

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
      const req = active || pending[0]
      if (!req) return { ok: false, error: '当前没有进行中的小艺会话' }
      const sent = channel.sendStatus(req.sessionId, req.taskId, req.messageId, text, 'working', false)
      return { ok: Boolean(sent), sessionId: req.sessionId, taskId: req.taskId }
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

  // ── HTTP 路由（给浏览器/脚本看状态） ──────────────────────────────────────

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

  // ── 启动/收尾 ─────────────────────────────────────────────────────────────

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
