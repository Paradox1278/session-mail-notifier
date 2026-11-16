/**
 * Unit tests for report composition.
 *
 * The fixtures are hand-written event logs with the same shape the agent loop
 * appends, so the parser is exercised on the real contract rather than on a
 * convenience object of my own invention.
 */

import {
  analyzeTurn,
  buildDeferredSummary,
  buildDigest,
  buildReport,
  count,
  duration,
  highlights,
  isFailure,
  nextSteps,
  reasonLabel,
  stamp,
} from '../report.js'

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.log(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  } else {
    console.log(`ok   ${label}`)
  }
}
function assert(label, condition) {
  check(label, condition === true, true)
}

const AT = new Date(2026, 10, 16, 23, 5, 12).getTime()

const REPLY = [
  '已经把插件拆成四层。',
  '',
  '## 做了什么',
  '- 新增 `report.js`',
  '- 新增 `queue.js`',
  '- 设置页加了模板选择',
  '',
  '## 下一步计划',
  '- 补单测',
  '- 清理个人信息后推仓库',
].join('\n')

function events() {
  const base = new Date(2026, 10, 16, 23, 0, 0).getTime()
  return [
    { type: 'user/message', time: base, data: { message: { content: [{ type: 'text', text: '把插件扩展一下' }] } } },
    { type: 'turn/start', time: base, data: { turn: 7 } },
    { type: 'step/start', time: base, data: { turn: 7, step: 1 } },
    { type: 'tool/result', time: base + 1000, data: { turn: 7, toolName: 'ops_bash' } },
    { type: 'step/end', time: base + 2000, data: { turn: 7, step: 1 } },
    {
      type: 'assistant/message',
      time: base + 3000,
      data: {
        turn: 7,
        step: 1,
        message: { content: [{ type: 'text', text: '先看事件结构' }] },
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400 },
      },
    },
    { type: 'step/start', time: base + 4000, data: { turn: 7, step: 2 } },
    { type: 'tool/result', time: base + 5000, data: { turn: 7, toolName: 'ops_bash' } },
    { type: 'tool/result', time: base + 6000, data: { turn: 7, toolName: 'edit' } },
    {
      type: 'assistant/message',
      time: base + 130_000,
      data: {
        turn: 7,
        step: 2,
        message: { content: [{ type: 'text', text: REPLY }] },
        usage: { inputTokens: 2000, outputTokens: 900, reasoningTokens: 300 },
      },
    },
    { type: 'turn/end', time: base + 138_000, data: { turn: 7, reason: { kind: 'completed' } } },
  ]
}

const SETTINGS = {
  subjectPrefix: 'DSH 汇报',
  template: 'structured',
  includeMetrics: true,
  failureAlerts: true,
  includeSummary: false,
  summaryChars: 400,
  notifyTo: 'target@example.com',
}

// --- primitives ------------------------------------------------------------
check('stamp', stamp(AT), '2026-11-16 23:05:12')
check('duration seconds', duration(48_000), '48s')
check('duration minutes', duration(138_000), '2m18s')
check('duration hours', duration(3_720_000), '1h02m')
check('count digits', count(1234567), '1,234,567')
check('count missing', count(undefined), null)
check('reasonLabel known', reasonLabel('completed'), '正常完成')
check('reasonLabel unknown', reasonLabel('weird'), 'weird')
assert('isFailure error', isFailure('error'))
assert('isFailure completed is false', isFailure('completed') === false)

// --- analyzeTurn -----------------------------------------------------------
const analysis = analyzeTurn({ events: events() }, 7)
check('turn recognised', analysis.turn, 7)
check('steps counted', analysis.steps, 2)
check('tool calls', analysis.toolCalls, 3)
check('tools ordered', analysis.tools, [{ name: 'ops_bash', times: 2 }, { name: 'edit', times: 1 }])
check('usage summed', {
  input: analysis.usage.inputTokens,
  output: analysis.usage.outputTokens,
  cache: analysis.usage.cacheReadTokens,
  reasoning: analysis.usage.reasoningTokens,
  samples: analysis.usage.samples,
}, { input: 3000, output: 1100, cache: 400, reasoning: 300, samples: 2 })
check('duration', analysis.durationMs, 138_000)
check('prompt captured', analysis.prompt, '把插件扩展一下')
check('reason captured', analysis.reason, 'completed')
check('reply is last text', analysis.reply, REPLY)

const otherTurn = analyzeTurn({ events: events() }, 6)
check('other turn has no usage', otherTurn.usage.samples, 0)

// --- templates -------------------------------------------------------------
const built = buildReport(SETTINGS, {
  sessionId: 'session-abc',
  title: '插件扩展',
  cwd: 'F:\\repo',
  analysis,
  at: AT,
})
check('subject', built.subject, 'DSH 汇报：插件扩展')
assert('body has three sections', ['一、做了什么', '二、过程', '三、下一步计划'].every(line => built.text.includes(line)))
assert('body lists a done bullet', built.text.includes('· 新增 report.js') || built.text.includes('· 新增 `report.js`'))
assert('body lists next step', built.text.includes('补单测'))
assert('body has token line', built.text.includes('Token：输入 3,000 / 输出 1,100 / 合计 4,100'))
assert('body has duration', built.text.includes('耗时 2m18s'))
assert('body names the turn', built.text.includes('turn 7'))
assert('summary omitted by default', built.text.includes('最后回复摘要') === false)

const failureAnalysis = analyzeTurn({
  events: [
    ...events().slice(0, 10),
    { type: 'turn/end', time: AT, data: { turn: 7, reason: { kind: 'error', error: { message: 'ECONNRESET' } } } },
  ],
}, 7)
const failed = buildReport(SETTINGS, {
  sessionId: 'session-abc',
  title: '插件扩展',
  cwd: '',
  analysis: failureAnalysis,
  at: AT,
})
check('failure subject', failed.subject, 'DSH 汇报：失败 · 插件扩展')
assert('failure body names the cause', failed.text.includes('ECONNRESET'))
assert('failure flag', failed.failure === true)

const brief = buildReport({ ...SETTINGS, template: 'brief' }, {
  sessionId: 'session-abc', title: '插件扩展', cwd: '', analysis, at: AT,
})
assert('brief has no sections', brief.text.includes('一、做了什么') === false)
assert('brief keeps metrics', brief.text.includes('Token：'))

// --- extraction ------------------------------------------------------------
check('highlights pick bullets', highlights(REPLY), [
  '新增 report.js',
  '新增 queue.js',
  '设置页加了模板选择',
  '补单测',
  '清理个人信息后推仓库',
])
check('nextSteps finds the section', nextSteps(REPLY), ['补单测', '清理个人信息后推仓库'])
check('nextSteps without a section', nextSteps('只是做了点事。'), [])

// --- digest and deferred summary ------------------------------------------
const items = [
  { at: AT, title: '插件扩展', turn: 7, reason: 'completed', durationMs: 138_000, ok: true },
  { at: AT + 60_000, title: '修按钮', turn: 3, reason: 'error', durationMs: 9_000, ok: false, error: 'ETIMEDOUT' },
]
const digest = buildDigest(SETTINGS, { items, at: AT })
check('digest subject', digest.subject, 'DSH 汇报：2026-11-16 日报（2 项，1 项失败）')
assert('digest rows carry state', digest.text.includes('[正常完成] 插件扩展') && digest.text.includes('[出错结束] 修按钮'))

const deferred = buildDeferredSummary(SETTINGS, { items, at: AT })
check('deferred subject', deferred.subject, 'DSH 汇报：静默期汇总（2 项）')
assert('deferred names the failure reason', deferred.text.includes('失败原因：ETIMEDOUT'))

console.log(failures === 0 ? '\nPASS: report.js' : `\nFAIL: ${failures} assertion(s)`)
if (failures > 0) process.exitCode = 1
