/**
 * Report composition.
 *
 * Everything here is pure: it takes the session's event log and the saved
 * settings and returns the subject and body of exactly one message. Keeping the
 * formatting out of the host half makes the template testable without a live
 * Session, and keeps `index.js` about delivery rather than prose.
 */

/** Completion states that count as a failure worth its own alert. */
const FAILURE_KINDS = new Set(['error', 'interrupted', 'cancelled', 'aborted', 'blocked', 'max-tokens'])

/** How many bullets one section may carry. */
const MAX_BULLETS = 6

const REASON_LABEL = {
  success: '正常完成',
  completed: '正常完成',
  interrupted: '被中断',
  cancelled: '被取消',
  aborted: '被中断',
  error: '出错结束',
  blocked: '被阻塞',
  'max-tokens': '达到输出上限',
}

const pad = (value) => String(value).padStart(2, '0')

/** `2026-11-16 23:10:04` in local time. */
export function stamp(at) {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '(未知时间)'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `2m18s` / `48s` / `1h02m`. */
export function duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '(未知)'
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h${pad(minutes)}m`
  if (minutes > 0) return `${minutes}m${pad(seconds)}s`
  return `${seconds}s`
}

/** Thousands separators, or `(未知)` when the provider reported nothing. */
export function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
    : null
}

/** The tool name carried by one `tool/result` event, whatever the shape. */
function toolName(event) {
  const data = event?.data ?? {}
  const candidate = data.toolName ?? data.name ?? data.tool ?? data.call?.name ?? data.toolCall?.name
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : 'tool'
}

/** Concatenate the text blocks of one assistant message. */
function assistantText(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** Concatenate the text blocks of one user message, which uses the same shape. */
function userText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** Add one provider usage sample into the running total. */
function addUsage(total, usage) {
  if (usage === null || typeof usage !== 'object') return
  const pick = (key) => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] : 0)
  total.inputTokens += pick('inputTokens')
  total.outputTokens += pick('outputTokens')
  total.cacheReadTokens += pick('cacheReadTokens')
  total.cacheWriteTokens += pick('cacheWriteTokens')
  total.reasoningTokens += pick('reasoningTokens')
  total.samples += 1
}

/**
 * Everything the report can say about one finished turn.
 *
 * The event log is the only source: `turn/start` marks the beginning, `turn/end`
 * the end, `assistant/message` carries provider usage, and `tool/result` counts
 * work actually performed. Usage samples are keyed by step so a retried step
 * cannot be counted twice.
 */
export function analyzeTurn(session, turn) {
  const events = Array.isArray(session?.events) ? session.events : []
  const result = {
    turn: turn ?? null,
    reason: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    steps: 0,
    tools: [],
    toolCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, samples: 0 },
    prompt: '',
    reply: '',
  }

  const stepSamples = new Map()
  const seenTools = new Map()
  let pendingPrompt = ''

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data ?? {}
    const eventTurn = typeof data.turn === 'number' ? data.turn : null
    if (event.type === 'user/message') {
      const text = userText(event)
      if (text.length > 0) pendingPrompt = text
      continue
    }
    if (turn !== null && eventTurn !== null && eventTurn !== turn) continue
    if (event.type === 'turn/start') {
      result.startedAt = typeof event.time === 'number' ? event.time : null
      result.prompt = pendingPrompt
      continue
    }
    if (event.type === 'turn/end') {
      result.finishedAt = typeof event.time === 'number' ? event.time : null
      result.reason = data.reason?.kind ?? null
      const failure = data.reason?.error ?? data.reason?.reason
      result.error = typeof failure?.message === 'string'
        ? failure.message
        : (typeof failure === 'string' ? failure : null)
      continue
    }
    if (event.type === 'step/start') {
      result.steps += 1
      continue
    }
    if (event.type === 'assistant/message') {
      const text = assistantText(event)
      if (text.length > 0) result.reply = text
      const key = `${eventTurn ?? 0}:${typeof data.step === 'number' ? data.step : result.steps}`
      stepSamples.set(key, data.usage ?? stepSamples.get(key) ?? null)
      continue
    }
    if (event.type === 'tool/result') {
      result.toolCalls += 1
      const name = toolName(event)
      seenTools.set(name, (seenTools.get(name) ?? 0) + 1)
    }
  }

  for (const usage of stepSamples.values()) addUsage(result.usage, usage)
  result.tools = [...seenTools.entries()]
    .map(([name, times]) => ({ name, times }))
    .sort((a, b) => b.times - a.times || a.name.localeCompare(b.name))
  if (result.startedAt !== null && result.finishedAt !== null && result.finishedAt >= result.startedAt) {
    result.durationMs = result.finishedAt - result.startedAt
  } else {
    result.durationMs = null
  }
  if (result.prompt.length === 0) result.prompt = pendingPrompt
  return result
}

/** True when the finished turn is a failure the owner asked to hear about. */
export function isFailure(reason) {
  return typeof reason === 'string' && FAILURE_KINDS.has(reason)
}

/** One-line state label used in subjects and digests. */
export function reasonLabel(reason) {
  return REASON_LABEL[reason] ?? (reason === null || reason === undefined ? '未知' : String(reason))
}

/** Strip markdown noise so a bullet reads as one sentence. */
function cleanLine(line) {
  return line
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/u, '')
    .replace(/^\s{0,3}#{1,6}\s+/u, '')
    .replace(/\*\*/gu, '')
    .replace(/`/gu, '')
    .trim()
}

/** Cut a long line at a word boundary, never mid-cluster. */
function clip(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit).trimEnd()}…`
}

/**
 * "What got done" bullets, taken from the assistant's own headings and bullets.
 *
 * A model reply is prose, so there is no reliable structure to read. Headings
 * and bullets are the two shapes an agent almost always emits when it reports
 * work, so they are tried first; failing both, the opening paragraph is used.
 */
export function highlights(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return []
  const lines = text.split('\n')
  const bullets = []
  const headings = []
  for (const line of lines) {
    if (/^\s{0,3}#{1,6}\s+/u.test(line)) {
      const heading = cleanLine(line)
      if (heading.length > 0) headings.push(heading)
      continue
    }
    if (/^\s{0,3}([-*+]|\d+[.)])\s+/u.test(line)) {
      const bullet = clip(cleanLine(line), 160)
      if (bullet.length > 0) bullets.push(bullet)
    }
  }
  const picked = bullets.length > 0 ? bullets : headings
  if (picked.length > 0) return picked.slice(0, MAX_BULLETS)

  const paragraph = lines
    .map(line => line.trim())
    .find(line => line.length > 0 && !/^\s{0,3}#{1,6}\s+/u.test(line))
  return paragraph === undefined ? [] : [clip(cleanLine(paragraph), 200)]
}

/**
 * "Next steps" bullets.
 *
 * A reply that plans further work says so under a heading whose name is one of a
 * handful of words; the section under that heading is the answer. Everything
 * else is a guess, so nothing is returned rather than an invented plan.
 */
export function nextSteps(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return []
  const keywords = /(下一步|后续|待办|计划|下一步计划|尚未完成|未完成|遗留|TODO|Next steps?|Follow[- ]?ups?|Remaining)/iu
  const lines = text.split('\n')
  const collected = []
  let inside = false
  for (const line of lines) {
    const isHeading = /^\s{0,3}#{1,6}\s+/u.test(line)
    if (isHeading) {
      inside = keywords.test(cleanLine(line))
      continue
    }
    if (!inside) continue
    if (/^\s{0,3}([-*+]|\d+[.)])\s+/u.test(line)) {
      const bullet = clip(cleanLine(line), 160)
      if (bullet.length > 0) collected.push(bullet)
      continue
    }
    const plain = cleanLine(line)
    if (plain.length > 0) collected.push(clip(plain, 160))
    if (collected.length >= MAX_BULLETS) break
  }
  return collected.slice(0, MAX_BULLETS)
}

/** The tool line: `ops_bash×7, edit×3`. */
function toolLine(tools) {
  if (tools.length === 0) return ''
  return tools.slice(0, 8).map(entry => `${entry.name}×${entry.times}`).join(', ')
}

/** The metrics block shared by both templates. */
function metricsBlock(analysis) {
  const lines = []
  const facts = []
  if (analysis.steps > 0) facts.push(`${analysis.steps} 步`)
  if (analysis.toolCalls > 0) facts.push(`工具调用 ${analysis.toolCalls} 次`)
  if (analysis.durationMs !== null) facts.push(`耗时 ${duration(analysis.durationMs)}`)
  if (facts.length > 0) lines.push(`执行：${facts.join('，')}`)
  if (analysis.startedAt !== null && analysis.finishedAt !== null) {
    lines.push(`起止：${stamp(analysis.startedAt)} → ${stamp(analysis.finishedAt)}`)
  }
  const usage = analysis.usage
  if (usage.samples > 0) {
    const parts = [`输入 ${count(usage.inputTokens) ?? 0}`, `输出 ${count(usage.outputTokens) ?? 0}`]
    const total = usage.inputTokens + usage.outputTokens
    parts.push(`合计 ${count(total) ?? 0}`)
    if (usage.cacheReadTokens > 0) parts.push(`缓存读 ${count(usage.cacheReadTokens)}`)
    if (usage.reasoningTokens > 0) parts.push(`推理 ${count(usage.reasoningTokens)}`)
    lines.push(`Token：${parts.join(' / ')}`)
  } else {
    lines.push('Token：服务商未上报用量')
  }
  const tools = toolLine(analysis.tools)
  if (tools.length > 0) lines.push(`工具：${tools}`)
  return lines
}

/**
 * Compose the report for one finished turn.
 *
 * Two shapes are offered. `structured` answers the three questions the owner
 * actually asks — what was done, how it went, what happens next. `brief` is one
 * screen of facts for people who only want the ping.
 */
export function buildReport(settings, context) {
  const { sessionId, title, cwd, analysis, at } = context
  const failure = isFailure(analysis.reason)
  const state = reasonLabel(analysis.reason)
  const name = title.length > 0 ? title : '(未命名会话)'
  const subject = failure
    ? `${settings.subjectPrefix}：失败 · ${name}`
    : `${settings.subjectPrefix}：${name}`

  const head = [
    failure ? 'DSH 会话任务失败专报' : 'DSH 会话任务汇报',
    '',
    `会话标题：${name}`,
    `会话 ID：${sessionId}`,
  ]
  if (cwd.length > 0) head.push(`工作目录：${cwd}`)
  head.push(`结束时间：${stamp(at)}`)
  head.push(`本轮序号：${analysis.turn === null ? '未知' : `turn ${analysis.turn}`}`)
  head.push(`结束状态：${state}`)

  if (failure && analysis.error !== null) {
    head.push('', '失败详情：', clip(analysis.error, 400))
  }

  const body = []
  if (settings.template === 'brief') {
    if (settings.includeMetrics) body.push('', ...metricsBlock(analysis))
  } else {
    body.push('', '一、做了什么')
    const done = highlights(analysis.reply)
    if (done.length > 0) for (const line of done) body.push(`· ${line}`)
    else body.push('· （本轮没有可提取的产出描述）')

    body.push('', '二、过程')
    if (analysis.prompt.length > 0) body.push(`· 本轮请求：${clip(analysis.prompt.replace(/\s+/gu, ' '), 200)}`)
    if (settings.includeMetrics) {
      for (const line of metricsBlock(analysis)) body.push(`· ${line}`)
    } else {
      body.push('· （按设置不发送执行指标）')
    }

    body.push('', '三、下一步计划')
    const next = nextSteps(analysis.reply)
    if (next.length > 0) for (const line of next) body.push(`· ${line}`)
    else body.push('· 助手未在回复中声明下一步，需要人工确认后续动作。')
  }

  if (settings.includeSummary && analysis.reply.length > 0) {
    const clipped = analysis.reply.length > settings.summaryChars
      ? `${analysis.reply.slice(0, settings.summaryChars)}\n…（已截断，原文 ${analysis.reply.length} 字）`
      : analysis.reply
    body.push('', '附：最后回复摘要', clipped)
  }

  const tail = ['', '—— 由 DSH 插件 Session Mail Notifier 自动发送']
  return { subject, text: [...head, ...body, ...tail].join('\n'), failure, state }
}

/**
 * The digest of one day's completions.
 *
 * Rows are deliberately flat so the mail stays readable in a phone preview: one
 * line per session, state first.
 */
export function buildDigest(settings, { items, at }) {
  const day = stamp(at).slice(0, 10)
  const failures = items.filter(entry => entry.ok === false).length
  const subject = failures > 0
    ? `${settings.subjectPrefix}：${day} 日报（${items.length} 项，${failures} 项失败）`
    : `${settings.subjectPrefix}：${day} 日报（${items.length} 项）`
  const lines = [`DSH 任务日报 ${day}`, '', `完成 ${items.length} 项，其中失败 ${failures} 项。`, '']
  for (const entry of items) {
    const state = reasonLabel(entry.reason)
    const name = entry.title.length > 0 ? entry.title : '(未命名会话)'
    const facts = []
    if (typeof entry.turn === 'number') facts.push(`turn ${entry.turn}`)
    if (typeof entry.durationMs === 'number') facts.push(duration(entry.durationMs))
    if (entry.ok === false) facts.push('已发失败专报')
    lines.push(`· ${stamp(entry.at).slice(11)} [${state}] ${name}${facts.length > 0 ? `（${facts.join('，')}）` : ''}`)
  }
  lines.push('', '—— 由 DSH 插件 Session Mail Notifier 自动发送')
  return { subject, text: lines.join('\n') }
}

/**
 * The combined message sent when a quiet period ends.
 *
 * Deferring is only acceptable if nothing is lost, so every held report is named
 * with its own state and time; the full bodies are intentionally not replayed.
 */
export function buildDeferredSummary(settings, { items, at }) {
  const subject = `${settings.subjectPrefix}：静默期汇总（${items.length} 项）`
  const lines = ['DSH 静默期汇总', '', `静默时段结束于 ${stamp(at)}，期间完成 ${items.length} 项任务。`, '']
  for (const entry of items) {
    const name = entry.title.length > 0 ? entry.title : '(未命名会话)'
    const facts = []
    if (typeof entry.turn === 'number') facts.push(`turn ${entry.turn}`)
    if (typeof entry.durationMs === 'number') facts.push(duration(entry.durationMs))
    lines.push(`· ${stamp(entry.at)} [${reasonLabel(entry.reason)}] ${name}${facts.length > 0 ? `（${facts.join('，')}）` : ''}`)
    if (entry.ok === false && typeof entry.error === 'string' && entry.error.length > 0) {
      lines.push(`  失败原因：${clip(entry.error, 200)}`)
    }
  }
  lines.push('', '—— 由 DSH 插件 Session Mail Notifier 自动发送')
  return { subject, text: lines.join('\n') }
}
