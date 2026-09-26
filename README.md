# dsh-xiaoyi —— 小艺通道（把手机上的小艺变成DSH的一只手）

## 这是什么

把「小艺开放平台 · **OpenClaw 模式**」的通道，直接实现成 **DSH 插件**：

```
手机小艺（在哪都行）
   │  语音/文字
   ▼
华为云 wss://hag.cloud.huawei.com/openclaw/v1/ws/link
   │  长连接（AK/SK 鉴权 + 30s 心跳）
   ▼
本插件（跑在 DSH 宿主里）  ←→  DSH 会话（DSH本体）
```

**没有第二个 agent**：小艺只是入口，接进的是同一个我（同一套记忆、插件、工具）。
和另一条通道（`其它插件`）并存，互不干扰。

## 依赖

**零第三方依赖**，只用 node 内置模块（含自研极简 WebSocket 客户端）。
插件树里少一个包，就少一次「加载失败→整个宿主起不来」的风险。

## 配置

状态文件：`~/.dsh/xiaoyi/state.json`

```json
{
  "enabled": true,
  "ak": "小艺开放平台凭证 AK",
  "sk": "小艺开放平台凭证 SK",
  "agentId": "OpenClaw 模式智能体的 agentId",
  "wsUrl": "wss://hag.cloud.huawei.com/openclaw/v1/ws/link",
  "sessionId": "xiaoyi-listen-xxxx"
}
```

也可以让DSH自己配：调用工具 `xiaoyi_set`（改 AK/SK/agentId/开关）。
日志：`~/.dsh/xiaoyi/xiaoyi.log`

## agent 工具

| 工具 | 作用 |
| --- | --- |
| `xiaoyi_status` | 看通道状态：连没连上、会话 id、队列、最后错误 |
| `xiaoyi_set` | 改凭证/开关（AK、SK、agentId、wsUrl、enabled） |
| `xiaoyi_send` | 主动往当前小艺会话推一句短消息（长任务收尾提醒） |
| `xiaoyi_reconnect` | 断线重连（改完凭证、连接发僵时用） |

## HTTP 路由

| 路径 | 作用 |
| --- | --- |
| `GET /xiaoyi/state` | JSON 状态 |
| `GET /xiaoyi/connect` | 启动通道 |
| `GET /xiaoyi/disconnect` | 断开通道 |

## 协议要点（照 `@ynhcj/xiaoyi` 0.0.8-beta 的 dist 核对）

- 鉴权请求头：`x-access-key` / `x-sign = Base64(HMAC-SHA256(SK, ts))` / `x-ts` / `x-agent-id`
- 握手：`{"msgType":"clawd_bot_init","agentId":"..."}`
- 心跳：每 30s `{"msgType":"heartbeat","agentId":"...","timestamp":...}` + 协议层 ping
- 入站：JSON-RPC 2.0，`method="message/stream"`
  - `sessionId = params.sessionId`、`taskId = params.id`、`messageId = 顶层 id`
- 出站：`{"msgType":"agent_response", agentId, sessionId, taskId, msgDetail:"<JSON-RPC>"}`
  - `result.kind = "status-update"`（`state=working`，先回执"任务正在处理中"）
  - `result.kind = "artifact-update"`（正文，`lastChunk=true, final=true` 收尾）
- 控制：`clearContext` / `tasks/cancel` / `action="clear"` → 回对应 JSON-RPC response

## 会话

小艺来的消息全部投进一条专用会话 `xiaoyi-listen-*`（冷启动优先 resume 同一条，
不重复新开对话），投递内容形如 `【小艺】<用户说的话>`。

## 卸载

1. 从 `~/.dsh/profiles/web/package.json` 的 `bundles` 与 `dependencies` 里删掉 `dsh-xiaoyi`
2. `dsh plugin --profile web install`
3. 冷启动宿主
