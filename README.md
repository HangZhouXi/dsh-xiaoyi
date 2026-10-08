# dsh-xiaoyi

把「**小艺开放平台 · OpenClaw 模式**」的通道实现成 **DSH 插件**：手机上的小艺（语音/文字/图片）直接对话到你本机运行的 DSH 会话。

> **这不是一个独立的聊天机器人。** 它只是"入口"，小艺连进来的是你本机那套 DSH 会话（同一套工具、同一份工作目录）。没有第二个 agent。

```
手机小艺（在哪都行）
   │  语音 / 文字 / 图片
   ▼
华为云  wss://hag.cloud.huawei.com/openclaw/v1/ws/link
   │  长连接（AK/SK 鉴权 + 30 秒心跳）
   ▼
本插件（跑在 DSH 宿主进程里）
   │
   ▼
DSH 会话  xiaoyi-listen-*
```

---

## 前置条件（先看完再装）

这个东西**不是开箱即用的**，装之前请确认三件事：

| # | 条件 | 说明 |
| --- | --- | --- |
| 1 | **你有一个 DSH 宿主** | DSH = DeepSeek Harness。本插件是宿主侧插件，没有宿主它跑不起来 |
| 2 | **你有小艺开放平台的 OpenClaw 模式凭证** | 需要 `AK` / `SK` / `agentId` 三样。这是华为云侧的开发者凭证，需要你自己去小艺开放平台申请开通 |
| 3 | **Node.js ≥ 20** | 代码用了内置的 `fetch` / `FormData` / `Blob`。开发环境是 Node 24 |

> 如果你拿不到第 2 项，也可以把这个仓库当成**协议实现参考**来读——`index.js` 里把 OpenClaw 的握手、鉴权、心跳、JSON-RPC 收发都写全了。

---

## 特性

- **零第三方依赖**：只用 Node 内置模块，**自己手写了 WebSocket 客户端**（RFC6455 客户端侧：文本帧、分片重组、ping/pong、握手校验）。
  插件树里少一个包，就少一次「某个包加载失败 → 整个宿主起不来」的风险。
- **完整协议实现**：鉴权签名、初始化握手、心跳与假死检测、JSON-RPC 2.0 流式收发、控制类消息（clearContext / tasks/cancel）。
- **入站附件自动落地**：小艺发来的图片/文件自动下载到本地，再把路径交给会话里的 agent（可直接 `read_image` / `read`）。
- **出站在线文件**：把本地文件发回小艺（协议只接受公网 https URL，支持本机隧道或第三方图床两种方式）。
- **会话复用**：冷启动优先 resume 原来那条会话，不重复新开对话。

---

## 安装

### 1. 放置源码

把本目录放到任意位置，推荐和其他插件放一起：

```
~/.dsh/plugin-sources/dsh-xiaoyi
```

### 2. 注册到 profile

**方式 A（推荐，一条命令）：**

```bash
# 从 GitHub 仓库装
dsh plugin --profile web add git+https://github.com/HangZhouXi/dsh-xiaoyi

# 或从 npm 装（发布到 npm 之后）
dsh plugin --profile web add dsh-xiaoyi
```

**方式 B（手动编辑）：**

编辑 `~/.dsh/profiles/web/package.json`：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // ...
        "dsh-xiaoyi"          // ← 加进 bundles
      ]
    }
  },
  "dependencies": {
    // ...
    "dsh-xiaoyi": "git+file:///C:/Users/<你>/.dsh/plugin-sources/dsh-xiaoyi"
  }
}
```

> 也可以直接用本地路径依赖：`"dsh-xiaoyi": "file:../../plugin-sources/dsh-xiaoyi"`。

### 3. 安装并冷启动

```bash
dsh plugin --profile web install
```

然后**冷启动 DSH 宿主**（不是热重载 —— 宿主端插件必须冷启动才生效）。

### 4. 填凭证

编辑 `~/.dsh/xiaoyi/state.json`：

```json
{
  "enabled": true,
  "ak": "小艺开放平台凭证 AK",
  "sk": "小艺开放平台凭证 SK",
  "agentId": "OpenClaw 模式智能体的 agentId",
  "wsUrl": "wss://hag.cloud.huawei.com/openclaw/v1/ws/link",
  "sessionId": "",
  "cwd": "C:\\Users\\<你>\\Desktop"
}
```

或者启动后让会话里的 agent 调工具 `xiaoyi_set` 直接改（改完立即生效，会重连）。

日志：`~/.dsh/xiaoyi/xiaoyi.log`

---

## 提供给 agent 的工具

| 工具 | 作用 |
| --- | --- |
| `xiaoyi_status` | 通道状态：凭证齐不齐、WebSocket 连没连上、监听会话 id、队列长度、最后错误、消息计数 |
| `xiaoyi_set` | 改凭证 / 开关（`ak`、`sk`、`agentId`、`wsUrl`、`enabled`），立即作用于活的连接 |
| `xiaoyi_send` | 主动往当前小艺会话推一句短消息（适合长任务收尾提醒） |
| `xiaoyi_send_photo` | 把本地图片/文件发给小艺（协议只收公网 https，见下方「出站文件」） |
| `xiaoyi_reconnect` | 强制断开重连（改完凭证、或连接发僵时用） |

## HTTP 路由

| 路径 | 作用 |
| --- | --- |
| `GET /xiaoyi/state` | JSON 状态 |
| `GET /xiaoyi/connect` | 启动通道（并确保监听会话就绪） |
| `GET /xiaoyi/disconnect` | 断开通道 |
| `GET /xiaoyi/public/<文件名>` | 出站文件的本机对外通道（文件名含随机串，不可猜） |

---

## 协议要点

> 照 `@ynhcj/xiaoyi` 的 dist 逐行核对过，实现上不依赖该包。

| 环节 | 内容 |
| --- | --- |
| 连接 | `wss://hag.cloud.huawei.com/openclaw/v1/ws/link` |
| 鉴权请求头 | `x-access-key`=AK、`x-sign`=`Base64(HMAC-SHA256(SK, ts))`、`x-ts`=毫秒、`x-agent-id`=agentId |
| 握手 | `{"msgType":"clawd_bot_init","agentId":"..."}` |
| 心跳 | 每 30s `{"msgType":"heartbeat","agentId":"...","timestamp":...}` + 协议层 ping |
| 入站 | JSON-RPC 2.0，`method="message/stream"`；`sessionId=params.sessionId`、`taskId=params.id`、`messageId`=顶层 `id`；文本在 `params.message.parts[kind=text].text`，附件在 `parts[kind=file].file{name,mimeType,uri}` |
| 出站 | `{"msgType":"agent_response", agentId, sessionId, taskId, msgDetail:"<JSON-RPC 字符串>"}` |
| 出站帧类型 | `result.kind="status-update"`（先回执 `state=working`）、`result.kind="artifact-update"`（正文，`lastChunk=true, final=true` 收尾） |
| 控制 | `clearContext` / `tasks/cancel` / `action="clear"` → 回对应 JSON-RPC response |

### 出站文件（`xiaoyi_send_photo`）

协议回给端侧的 Part 是 `{ url, filename, mediaType }` —— **只接受公网 https 地址，没有"上传字节"的接口**。所以有两种模式：

| mode | 行为 | 隐私 |
| --- | --- | --- |
| `local`（**默认**） | 复制到 `~/.dsh/xiaoyi/public/`，由本插件自己的路由对外提供，再配合一条隧道（如 `localhost.run`）把 `state.publicBaseUrl` 指过来 | 文件不出本机（除了隧道） |
| `catbox` | 上传到第三方图床 `catbox.moe` | **文件会被传到第三方**，必须显式指定才启用 |

配 `state.publicBaseUrl` 之后 `local` 模式才能用；没配就直接报错，**不会**偷偷回退到图床。

---

## 安全与隐私

- **凭证只存在本地** `~/.dsh/xiaoyi/state.json`，已被 `.gitignore` 排除，不进仓库、不进日志（日志只记录"有/无"）。
- **入站附件有 SSRF 防护**：入站 `uri` 来自外部消息，属于不可信输入。插件只允许 `http/https`，拒绝环回/私网/链路本地地址（含 `169.254.169.254` 这类云元数据地址），**重定向之后会再检查一次落点**。
- **附件有体积闸门**：单文件上限 50 MB，流式读取，对方少报 `content-length` 也不会把内存打爆。
- **出站公开链接不可猜**：文件名带 8 字节随机串。
- ⚠️ **HTTP 路由本身没有鉴权**。`/xiaoyi/state`、`/xiaoyi/public/*` 谁都能访问。请**不要**把 DSH 的端口裸奔到公网；要走隧道的话，用带鉴权/随机域名的方案。

---

## 已知限制

- **出站附件必须走公网 URL**：这是协议限制，不是实现偷懒。
- **入站附件链接是预签名的、大约 30 分钟过期**：所以必须"一到就抓"。本插件就是这么做的；如果下载失败，基本就是链接已经过期。
- **`media/` 目录不会自动清理**：长期使用请自己定期清理 `~/.dsh/xiaoyi/media/`。
- **平台侧策略可能变**：OpenClaw 模式、地址、字段都可能随华为侧调整而失效，本插件不保证长期可用。

---

## 卸载

1. 从 `~/.dsh/profiles/web/package.json` 的 `bundles` 与 `dependencies` 里删掉 `dsh-xiaoyi`
2. `dsh plugin --profile web install`
3. 冷启动宿主
4. 想彻底清净的话，删掉 `~/.dsh/xiaoyi/`（里面有凭证和日志）

---

## 排错

| 现象 | 排查方向 |
| --- | --- |
| 装完没反应 | **冷启动**了吗？宿主端插件热重载不生效 |
| `status` 里 `ready:false` | AK / SK / agentId 有缺项 |
| 一直连不上、`lastError` 有握手错误 | `wsUrl` 是否被改错；网络是否能到 `hag.cloud.huawei.com:443` |
| 连上又断、反复重连 | 看日志里的"连接假死"；超过 90 秒没有任何回音（含 pong）会主动重连 |
| 小艺发消息没回应 | 看 `~/.dsh/xiaoyi/xiaoyi.log`；确认宿主日志里插件是否加载成功 |
| 收到「DSH 会话未就绪」 | 宿主启动后第一次请求要现建会话，稍等再发一次 |
| 发的图片收不到 | 协议要求公网 https。检查 `publicBaseUrl` 有没有配、隧道还活着吗 |

---

## 许可

[MIT](./LICENSE)

## 免责声明

**使用前请务必读 [`DISCLAIMER.md`](./DISCLAIMER.md)。**
