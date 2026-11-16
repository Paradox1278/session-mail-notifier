# 实现细节

面向维护者。README 讲怎么用，这里讲数据长什么样、一次汇报是怎样被决定和投递的。

## 1. 数据模型

所有状态存在一条 DSH 凭据记录里（键 `session-mail-notifier/settings`，`kind: 'grant'`）；没有 credentials 服务时退化到 `<DSH_HOME>/session-mail-notifier.json`。页面读到的永远是 `publicView()` 投影，授权码只回 `hasPass: true`。

```
{
  enabled, bindEmail, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass,
  notifyTo, subjectPrefix, includeSummary, summaryChars, template, includeMetrics,
  failureAlerts, retryLimit, retryBaseMs,
  quiet:    { enabled, from: '22:00', to: '08:00' },
  digest:   { enabled, at: '09:00', lastAt },
  watches:  [{ id, title, addedAt }],
  lastSent: { [sessionId]: { turn, at } },
  verifiedAt, history: [ … ],
  outbox:       [ job ],
  deferred:     [ pending ],
  digestBuffer: [ entry ]
}
```

- `history`：最近 50 条投递结果，字段 `{at, sessionId, title, to, ok, deferred, queued, error, turn, reason, durationMs, buffered}`。
- `outbox`：待重试，最多 20 条，`job = {id, kind, to, subject, text, attempts, createdAt, nextAt, sessionId, title, turn, reason, durationMs, lastError}`。
- `deferred`：静默期暂存的汇报，最多 50 条。
- `digestBuffer`：等日报的成功投递，最多 200 条。

写入统一走 `mutate()` 串行队列，避免并发读改写丢更新；落盘前做一次 JSON 往返（`plain()`），因为凭据提供方拒绝 `undefined` 这类不可表示的值。

## 2. 完成检测

```
ctx.on('agent/status', ({ agent, status }))
  status === 'idle' 且上一态是 'running'
    → 等 1200ms（SETTLE_MS，让 turn/end 落盘）
    → turn = 最后一个 turn/end 的 data.turn
    → 若 lastSent[sessionId].turn === turn 则视为已汇报，跳过
    → report()
```

一轮的结束状态取 `turn/end` 的 `reason.kind`：`completed` / `aborted` / `blocked` / `error` / `max-tokens` / `interrupted` / `forked`。前六个之外的都算正常结束，`error`/`aborted`/`blocked`/`max-tokens`/`interrupted` 算失败。

事件读取兼容两种形状：真实 `Session` 的 `snapshotEvents()`，以及测试替身里的 `events` 数组。

## 3. 一轮怎么被解析成汇报

`report.js#analyzeTurn(events, turn)` 单次遍历：

| 事件 | 采集 |
| --- | --- |
| `turn/start` | `startedAt` |
| `user/message` | 本轮请求文本 |
| `step/start` | 步数 |
| `assistant/message` | 最后回复文本；`usage` 按 step 去重后累加 |
| `tool/result` | 工具调用次数与工具名计数 |
| `turn/end` | `finishedAt`、`reason`、错误信息 |

`durationMs = finishedAt - startedAt`。指标按 step 去重是为了"重发同一轮"时不把 token 重复计入。

正文由 `buildReport()` 生成：

- **主题**：`<prefix>：<标题>`，失败时插一句 `失败 · `。
- **一、做了什么**：从回复里抽 bullet / 小标题，最多 6 条。
- **二、过程**：本轮请求 + 执行概览（步数、工具次数、耗时、起止时刻、token、工具清单）。
- **三、下一步计划**：找回复里含「下一步 / 后续 / 待办 / 计划 / TODO / Next steps」的段落；找不到就明说"助手未在回复中声明下一步"，不编造。
- 失败轮另加「失败详情」段，含 `reason.kind` 与服务端错误文本。

`template: 'brief'` 只保留状态与指标。

## 4. 投递决策

```
report()
 └─ 静默时段中？ → deferred.push(…)  返回 {deferred: true, until}
 └─ deliver()
     ├─ 成功 → history.push(ok) → lastSent / verifiedAt → 进 digestBuffer
     └─ 失败 → outbox.push(job)  nextAt = now + retryBaseMs
```

调度器每 30 秒跑一次 `tick()`：

1. 静默已结束且 `deferred` 非空 → 合成「静默期汇总」发送，成功则清空。
2. `outbox` 中 `nextAt <= now` 的逐条重投；成功则移除并补一条 history（进日报缓冲）；`attempts` 超过 `retryLimit` 则丢弃并记一条「重试 N 次后放弃」。
3. `digest.enabled` 且当前时刻已过今天的 `at`、且 `lastAt` 早于今天该时刻、且缓冲非空 → 发日报，清缓冲，写 `lastAt`。

页面上的「立即处理队列」走 `POST /queue {action:'flush'}`，调用 `tick({force: true})`：**忽略退避时间**，把队列里的东西立刻试一遍。退避只约束无人值守的自动重投，不该阻止人手动推它一把。

退避：`retryAt(attempts) = min(base × 3^(attempts-1), 3_600_000)`，即 1×、3×、9×…封顶一小时。

## 5. 静默时段

半开区间比较分钟数，支持跨午夜（`from > to` 时区间为 `[from, 24:00) ∪ [00:00, to)`）。时钟串必须匹配 `^([01]\d|2[0-3]):[0-5]\d$`，不合法的值在 `normalize()` 里被换回默认，页面不会因为一个错字而拒绝保存。

## 6. HTTP 路由

全部挂在 `/session-mail-notifier` 前缀下，进入处理函数先过 `ctx.connection.requestRejection(req)`——未登录的请求在插件看到之前就被 401/403 拦掉。

| 方法 | 路径 | 入参 | 返回 |
| --- | --- | --- | --- |
| GET | `/state` | — | `{ok, settings, sessions}` |
| GET | `/sessions` | — | 活动会话列表 |
| POST | `/settings` | 任意设置字段 + `verify` | `{ok, settings, verified, error}` |
| POST | `/watch` | `{id, title, watch}` | `{ok, live, settings}` |
| POST | `/report` | `{id}` | `{ok, to, deferred?, queued?, error?}` |
| POST | `/test` | — | `{ok, to, error}` |
| POST | `/history` | `{clear: true}` | `{ok, settings}` |
| POST | `/queue` | `{action:'flush'\|'clear'}` | `{ok, flushed, retried, digest, settings}` |

`/settings` 是 patch 语义：只覆盖请求体里出现的字段；`digest.lastAt` 由服务端保留，页面覆盖不掉。

## 7. SMTP 客户端

`smtp.js` 只用 `node:net` / `node:tls`：

- 465 → 连接即 TLS（带 `servername`，SNI 正确）；
- 587 / 25 → 明文 EHLO，`STARTTLS` 后升级 socket 再 EHLO 一次；
- `AUTH LOGIN` / `AUTH PLAIN`，按服务器声明的能力选；
- 主题走 RFC 2047 `=?UTF-8?B?…?=`，正文 base64 76 列并做点填充，`Date` / `Message-ID` / `MIME-Version` 齐备。

认证失败时抛的是可读诊断：原始错误 + 该服务商取授权码的路径 + 排查清单（用户名不是邮箱、验证码为空、首尾空格、长度不对、端口与加密方式不匹配）。这类错误会原样进 `outbox.lastError` 与页面提示。

## 8. 已知限制

- 只认一轮的**结束**，不汇报"进行中"；会话被删除后其 watch 项留在列表里并标为不活动。
- 汇报正文取自会话事件，不额外调用模型，因此"下一步计划"只能来自助手自己写下的话。
- 邮件是纯文本（base64 编码的 `text/plain`），不带 HTML 与附件。
- 多收件人、多套 SMTP 账号尚未实现；`notifyTo` 目前是单地址。
