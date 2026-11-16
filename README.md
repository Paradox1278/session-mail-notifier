# 会话完成邮件汇报 · Session Mail Notifier

DeepSeek Harness（DSH）插件。指定一个会话 ID，当这个会话**完成一轮任务**时，插件用你绑定的邮箱把这一轮的完成情况发到目标邮箱——长任务、无人值守任务的结果可以直接落到手机邮件里。

- 零依赖：SMTP 客户端是仓库内自带的实现，不引入任何第三方包
- 自带页面：侧边栏入口 + 整页、设置页一节、会话行快捷按钮
- 失败不丢：SMTP 拒收自动进重试队列，按指数退避重投
- 汇报有结构：做了什么 / 过程（步数、工具、token、耗时）/ 下一步计划

## 功能

| 能力 | 说明 |
| --- | --- |
| 完成检测 | 监听 `agent/status` 的 running → idle，取该会话最后一个 `turn/end` 作为"完成"，按 turn 去重 |
| 绑定邮箱 | 页面上填写发件邮箱、SMTP 服务器、端口、加密方式、授权码；账号密码存在 DSH 凭据记录里，页面只回显"已保存" |
| 保存并验证 | 保存后立刻用该账号发一封验证邮件，收到即绑定可用 |
| 汇报模板 | `structured`（三段式：做了什么 / 过程 / 下一步计划）或 `brief`（状态 + 指标） |
| 自动指标 | 每封信附 token 用量（输入 / 输出 / 合计）、耗时、执行步数、工具调用次数与清单 |
| 失败专报 | 本轮以 error / aborted / blocked / max-tokens 结束时，主题带"失败"，正文加失败详情 |
| 重试队列 | 投递失败进队列，按 `base × 3^(n-1)` 退避重投（上限 1 小时），超过次数后放弃并记一条记录；页面可"立即处理队列" |
| 静默时段 | 默认关闭。开启后落在时段内的汇报先暂存，时段结束后合并成一封"静默期汇总" |
| 日报 | 默认关闭。设定时刻后，把当天成功的汇报汇总成一封日报 |

## 安装

插件以本地 bundle 形式安装（需要 DSH 的 plugin manager）：

```bash
# 在 DSH 里执行，target 指向本目录
plugin_manager install_bundle target=/path/to/session-mail-notifier
```

安装后 `cordis.patch.yml` 会被并入 profile，插件随 DSH 启动加载。改完源码后无需重启应用，禁用再启用一次该插件即可热重载。

## 使用

1. 侧边栏点开 **完成邮件汇报**（和"插件""插件市场"同一排），或从 **设置 → 完成邮件汇报** 进入。
2. 「发件邮箱」卡片里选服务商（163 / 126 / QQ / Gmail / Outlook / 自定义），自动带出服务器与端口，填**授权码**，点 **保存并验证**。
3. 「监控一个会话」卡片里粘贴**会话 ID** → 开始监控；也可以直接点下面的活动会话，或用会话行右侧的信封按钮。
4. 之后该会话每完成一轮就自动发信；「立即汇报」可随时手动触发一次。

> 授权码不是网页登录密码。QQ 邮箱在"设置 → 账户 → POP3/SMTP 服务"里生成，163 在"设置 → POP3/SMTP/IMAP"里开启后取得。
> 用户名要填**完整邮箱地址**，留空则自动使用绑定邮箱——填成昵称一定会得到 `535`。

## 汇报长什么样

```
主题：[DSH] 任务完成：季度报告整理

DSH 会话任务汇报

会话标题：季度报告整理
会话 ID：session-0000…
工作目录：/path/to/project
结束时间：2026-01-01 09:30:00
本轮序号：turn 3
结束状态：正常完成

一、做了什么
· 生成了 report-q4.md，共 12 页
· 修正了统计口径

二、过程
· 本轮请求：帮我整理季度报告
· 执行：4 步，工具调用 7 次，耗时 2m 18s
· 起止：09:27:42 → 09:30:00
· Token：输入 12,480 / 输出 3,210 / 合计 15,690
· 工具：ops_bash×4、read×3

三、下一步计划
· 等你确认口径后再出图表
```

指标按 `assistant/message` 的 usage 逐 step 去重后累加，所以重发同一轮不会重复计数。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关，关掉后完成事件不再发信 |
| `bindEmail` / `smtpUser` / `smtpPass` | 空 | 发件邮箱、SMTP 用户名（留空＝绑定邮箱）、授权码 |
| `smtpHost` / `smtpPort` / `smtpSecure` | `smtp.163.com` / `465` / `true` | `secure` 为真走隐式 TLS，为假走 STARTTLS |
| `notifyTo` | 空 | 汇报目标邮箱 |
| `subjectPrefix` | `[DSH] 任务完成` | 主题前缀 |
| `template` | `structured` | `structured` / `brief` |
| `includeMetrics` | `true` | 是否附 token 用量与耗时 |
| `includeSummary` / `summaryChars` | `true` / `1200` | 是否附最后回复摘要及其长度 |
| `failureAlerts` | `true` | 失败轮是否发专报 |
| `retryLimit` / `retryBaseMs` | `4` / `60000` | 重试次数与首次退避间隔 |
| `quiet` | `{enabled:false, from:'22:00', to:'08:00'}` | 静默时段，支持跨午夜 |
| `digest` | `{enabled:false, at:'09:00'}` | 日报时刻 |

## 结构

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 半边：路由、完成检测、投递策略、定时调度 |
| `client.js` | Browser 半边：侧边栏入口、整页、设置分区、会话行按钮 |
| `smtp.js` | 零依赖 SMTP 客户端（隐式 TLS / STARTTLS、AUTH LOGIN/PLAIN、UTF-8 主题与正文） |
| `store.js` | 设置持久化（DSH 凭据记录，退化到 `<DSH_HOME>/session-mail-notifier.json`） |
| `report.js` | 纯函数：解析一轮事件、生成汇报正文、日报与静默期汇总 |
| `queue.js` | 纯函数：静默时段判断、指数退避、队列增删、日报时刻 |

HTTP 路由（均挂在 `/session-mail-notifier` 下）：`/state`、`/sessions`、`/settings`、`/watch`、`/report`、`/test`、`/history`、`/queue`。所有请求先过 `connection.requestRejection`，浏览器未登录直接 401。

## 开发

```bash
node test/smtp-test.mjs        # SMTP 协议层（脚本化服务器）
node test/host-test.mjs        # 假 Cordis 上下文跑完整链路
node test/client-render-test.mjs  # 浏览器半边渲染
node test/report-test.mjs      # 汇报生成
node test/queue-test.mjs       # 退避、静默、日报时刻
node test/scheduler-test.mjs   # 重试 / 静默 / 日报 三种投递路径
```

`client.js` 是纯浏览器脚本（`window.__ModuleLoader__`），改完先 `node --check client.js`。

## 许可

MIT
