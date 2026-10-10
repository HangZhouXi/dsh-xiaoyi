# dsh-xiaoyi

**English** | [简体中文](./README.zh-CN.md)

A **DSH (DeepSeek Harness) host plugin** that connects **Huawei XiaoYi in OpenClaw mode** to your local DSH session — voice, text and images from your phone reach the agent running on your own machine.

> **This is not a standalone chatbot.** XiaoYi is only the entry point; what it connects to is your local DSH session (same tools, same working directory). There is no second agent.

```
Huawei XiaoYi on your phone  (anywhere)
   │  voice / text / images
   ▼
Huawei Cloud  wss://hag.cloud.huawei.com/openclaw/v1/ws/link
   │  long-lived connection (AK/SK auth + 30s heartbeat)
   ▼
This plugin  (runs inside the DSH host process)
   │
   ▼
DSH session  xiaoyi-listen-*
```

---

## Prerequisites

This is **not** plug-and-play. Before installing, make sure you have all three:

| # | Requirement | Notes |
| --- | --- | --- |
| 1 | **A DSH host** | DSH = DeepSeek Harness. This is a host-side plugin; without a host it cannot run. |
| 2 | **XiaoYi Open Platform credentials (OpenClaw mode)** | You need `AK` / `SK` / `agentId`. These are Huawei Cloud developer credentials you must apply for yourself on the XiaoYi Open Platform. |
| 3 | **Node.js ≥ 20** | The code uses the built-in `fetch` / `FormData` / `Blob`. Developed on Node 24. |

> If you cannot obtain item 2, you can still read this repository as a **protocol reference implementation** — `index.js` implements the XiaoYi/OpenClaw handshake, auth, heartbeat and JSON-RPC message exchange in full.

---

## Features

- **Zero third-party dependencies.** Only Node built-ins are used, including a **hand-written minimal WebSocket client** (RFC6455 client side: text frames, fragmentation reassembly, ping/pong, and handshake verification). Fewer packages in the plugin tree means fewer chances that one failed package takes the whole host down.
- **Complete protocol implementation.** Auth signing, init handshake, heartbeat with stale-connection detection, JSON-RPC 2.0 streaming, and control messages (`clearContext` / `tasks/cancel`).
- **Inbound attachments.** Images and files sent from XiaoYi are downloaded to disk, and their local paths are handed to the agent in the session (ready for `read_image` / `read`).
- **Outbound online files.** Send local files back to XiaoYi (the protocol only accepts public https URLs; supports a local tunnel or a third-party image host).
- **Session reuse.** On a cold start the plugin resumes the existing session instead of opening a new conversation every time.

---

## Installation

### 1. Place the source

Put this directory anywhere you keep plugins. The conventional location is:

```
~/.dsh/plugin-sources/dsh-xiaoyi
```

### 2. Register it in your profile

**Option A (recommended, one command):**

```bash
# install from the GitHub repository
dsh plugin --profile web add git+https://github.com/HangZhouXi/dsh-xiaoyi

# or from npm (after it is published there)
dsh plugin --profile web add dsh-xiaoyi
```

**Option B (edit by hand):**

Edit `~/.dsh/profiles/web/package.json`:

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // ...
        "dsh-xiaoyi"          // ← add to bundles
      ]
    }
  },
  "dependencies": {
    // ...
    "dsh-xiaoyi": "git+file:///C:/Users/<you>/.dsh/plugin-sources/dsh-xiaoyi"
  }
}
```

> A plain local path dependency also works: `"dsh-xiaoyi": "file:../../plugin-sources/dsh-xiaoyi"`.

### 3. Install and cold-start

```bash
dsh plugin --profile web install
```

Then **cold-start the DSH host**. (Host-side plugins are not applied by hot reload — a cold start is required.)

### 4. Provide credentials

Edit `~/.dsh/xiaoyi/state.json`:

```json
{
  "enabled": true,
  "ak": "XiaoYi Open Platform AK",
  "sk": "XiaoYi Open Platform SK",
  "agentId": "agentId of your OpenClaw-mode agent",
  "wsUrl": "wss://hag.cloud.huawei.com/openclaw/v1/ws/link",
  "sessionId": "",
  "cwd": "C:\\Users\\<you>\\Desktop",
  "publicBaseUrl": "",
  "imageHost": ""
}
```

| Field | Purpose |
| --- | --- |
| `enabled` | Master switch. `false` disconnects the channel. |
| `ak` / `sk` / `agentId` | XiaoYi Open Platform credentials. All three are required. |
| `wsUrl` | WebSocket endpoint. Leave as the default unless Huawei changes it. |
| `sessionId` | The DSH session to reuse. Normally written by the plugin itself. |
| `cwd` | Working directory for the session. Must be writable. |
| `publicBaseUrl` | Only for outbound files in `local` mode: the public https base URL of your tunnel. |
| `imageHost` | Optional default publisher for outbound files. Set `"catbox"` to make catbox.moe the default; leave empty to stay local-only. |

You can also let the agent configure these at runtime with the `xiaoyi_set` tool (changes take effect immediately and reconnect).

Log file: `~/.dsh/xiaoyi/xiaoyi.log`

---

## Agent tools

| Tool | Purpose |
| --- | --- |
| `xiaoyi_status` | Channel status: whether credentials are complete, whether the WebSocket is connected, the listening session id, queue length, last error, message counters. |
| `xiaoyi_set` | Update credentials / switch (`ak`, `sk`, `agentId`, `wsUrl`, `enabled`). Takes effect immediately on the live connection. |
| `xiaoyi_send` | Push a short message to the current XiaoYi conversation (useful as a long-task completion notice). |
| `xiaoyi_send_photo` | Send a local image or file to XiaoYi (the protocol only accepts public https; see "Outbound files" below). |
| `xiaoyi_reconnect` | Force a disconnect and reconnect (after changing credentials, or when the link looks stale). |

## HTTP routes

| Path | Purpose |
| --- | --- |
| `GET /xiaoyi/state` | JSON status. |
| `GET /xiaoyi/connect` | Start the channel and make sure the listening session is ready. |
| `GET /xiaoyi/disconnect` | Stop the channel. |
| `GET /xiaoyi/public/<filename>` | Serves published outbound files. Filenames carry a random component and are not guessable. |

---

## Protocol summary

> Verified against the published artifacts of `@ynhcj/xiaoyi`. This project does not depend on that package.

| Stage | Detail |
| --- | --- |
| Endpoint | `wss://hag.cloud.huawei.com/openclaw/v1/ws/link` |
| Auth headers | `x-access-key`=AK, `x-sign`=`Base64(HMAC-SHA256(SK, ts))`, `x-ts`=milliseconds, `x-agent-id`=agentId |
| Handshake | `{"msgType":"clawd_bot_init","agentId":"..."}` |
| Heartbeat | Every 30s `{"msgType":"heartbeat","agentId":"...","timestamp":...}` plus a protocol-level ping |
| Inbound | JSON-RPC 2.0, `method="message/stream"`; `sessionId=params.sessionId`, `taskId=params.id`, `messageId`=top-level `id`; text in `params.message.parts[kind=text].text`, attachments in `parts[kind=file].file{name,mimeType,uri}` |
| Outbound | `{"msgType":"agent_response", agentId, sessionId, taskId, msgDetail:"<JSON-RPC string>"}` |
| Outbound frame kinds | `result.kind="status-update"` (acknowledge with `state=working`), `result.kind="artifact-update"` (the body, closed with `lastChunk=true, final=true`) |
| Control | `clearContext` / `tasks/cancel` / `action="clear"` → reply with the matching JSON-RPC response |

### Outbound files (`xiaoyi_send_photo`)

The Part sent back to the client is `{ url, filename, mediaType }` — **only public https URLs are accepted; there is no "upload bytes" interface**. Hence two modes:

| mode | Behaviour | Privacy |
| --- | --- | --- |
| `local` (**default**) | The file is copied to `~/.dsh/xiaoyi/public/` and served by this plugin's own route; pair it with a tunnel (e.g. `localhost.run`) and point `state.publicBaseUrl` at it. | The file never leaves your machine (except through your tunnel). |
| `catbox` | Uploads to the third-party host `catbox.moe`. | **The file is sent to a third party.** Must be requested explicitly. |

`local` mode requires `state.publicBaseUrl`; without it the tool returns an error and **never** silently falls back to an image host.

---

## Security and privacy

- **Credentials stay local.** They live in `~/.dsh/xiaoyi/state.json`, which is excluded by `.gitignore`. They are never committed and never logged (the log only records whether a value is present).
- **Inbound attachments are protected against SSRF.** The inbound `uri` comes from an external message and is treated as untrusted input. Only `http`/`https` is allowed; loopback, private and link-local addresses are rejected (including cloud metadata endpoints such as `169.254.169.254`), and **redirect targets are checked again**.
- **Attachments are size-capped.** 50 MB per file, read as a stream, so a lying `content-length` cannot exhaust memory.
- **Published URLs are unguessable.** Filenames include 8 random bytes.
- ⚠️ **The HTTP routes themselves have no authentication.** `/xiaoyi/state` and `/xiaoyi/public/*` are reachable by anyone who can reach the port. Do **not** expose the DSH port directly to the internet; if you use a tunnel, prefer one with authentication or an unguessable hostname.

---

## Known limitations

- **Outbound attachments must use a public URL.** This is a protocol constraint, not a shortcut in the implementation.
- **Inbound attachment URLs are pre-signed and expire in roughly 30 minutes**, so they must be fetched immediately. This plugin does exactly that; if a download fails, the link has most likely expired.
- **The `media/` directory is never cleaned automatically.** Prune `~/.dsh/xiaoyi/media/` yourself periodically.
- **Platform-side policies may change.** OpenClaw mode, endpoints and field names can be adjusted by Huawei at any time; long-term availability is not guaranteed.

---

## Uninstall

1. Remove `dsh-xiaoyi` from `bundles` and `dependencies` in `~/.dsh/profiles/web/package.json`.
2. `dsh plugin --profile web install`
3. Cold-start the host.
4. For a complete cleanup, delete `~/.dsh/xiaoyi/` (it contains credentials and logs).

---

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Nothing happens after installing | Did you **cold-start**? Host-side plugins are not applied by hot reload. |
| `status` reports `ready:false` | One of AK / SK / agentId is missing. |
| Cannot connect, `lastError` mentions a handshake failure | Is `wsUrl` correct? Can the machine reach `hag.cloud.huawei.com:443`? |
| Connects then keeps reconnecting | Look for "stale connection" in the log; if nothing (including pong) arrives for over 90 seconds the plugin reconnects on purpose. |
| XiaoYi messages get no reply | Check `~/.dsh/xiaoyi/xiaoyi.log` and confirm in the host log that the plugin loaded. |
| Reply says the DSH session is not ready | The very first request after a host start has to create the session; send the message again shortly after. |
| Sent images do not arrive | The protocol requires a public https URL. Check `publicBaseUrl` and whether your tunnel is still alive. |

---

## License

[MIT](./LICENSE)

## Disclaimer

**Please read [`DISCLAIMER.md`](./DISCLAIMER.md) before use.**
