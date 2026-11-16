/**
 * Scheduler harness: proves the three delivery destinations against a scripted
 * SMTP server.
 *
 *   1. a report SMTP refuses goes into the retry queue and later arrives;
 *   2. a report produced inside quiet hours is held, then summarised once the
 *      window closes;
 *   3. the daily digest fires once the configured clock hour has passed.
 *
 * The queue's own timers are not waited on: `nextAt` is nudged into the past
 * through the credential record, then `/queue` flushes deterministically.
 */

import net from 'node:net'
import { apply } from '../index.js'

const mailboxes = []
let failNextData = false

function startSmtp() {
  const server = net.createServer((socket) => {
    let buffer = ''
    let phase = 'command'
    let lines = []
    socket.write('220 fake.smtp ready\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        if (phase === 'data') {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          lines.push(buffer.slice(0, end))
          buffer = buffer.slice(end + 5)
          mailboxes.push(decodeMail(lines.join('\r\n')))
          lines = []
          phase = 'command'
          socket.write('250 stored\r\n')
          continue
        }
        const newline = buffer.indexOf('\r\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 2)
        if (phase === 'auth-user') { phase = 'auth-pass'; socket.write('334 UGFzc3dvcmQ6\r\n'); continue }
        if (phase === 'auth-pass') { phase = 'command'; socket.write('235 ok\r\n'); continue }
        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO')) socket.write('250-fake\r\n250-AUTH LOGIN\r\n250 OK\r\n')
        else if (upper === 'AUTH LOGIN') { phase = 'auth-user'; socket.write('334 VXNlcm5hbWU6\r\n') }
        else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) socket.write('250 ok\r\n')
        else if (upper === 'DATA') {
          if (failNextData) {
            failNextData = false
            socket.write('451 4.3.0 try again later\r\n')
            continue
          }
          phase = 'data'
          socket.write('354 go\r\n')
        } else if (upper === 'QUIT') { socket.write('221 bye\r\n'); socket.end() }
        else if (upper === 'RSET') socket.write('250 reset\r\n')
        else socket.write('250 ok\r\n')
      }
    })
    socket.on('error', () => undefined)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

function decodeMail(raw) {
  const [headerBlock, ...rest] = raw.split('\r\n\r\n')
  const headers = Object.fromEntries(headerBlock.split('\r\n').map((line) => {
    const index = line.indexOf(':')
    return index < 0 ? [line, ''] : [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()]
  }))
  const decodedWord = (value) => {
    const match = /=\?UTF-8\?B\?(.+)\?=/.exec(value ?? '')
    return match ? Buffer.from(match[1], 'base64').toString('utf8') : (value ?? '')
  }
  return {
    subject: decodedWord(headers.subject),
    to: headers.to ?? '',
    body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8'),
  }
}

const { server, port } = await startSmtp()

const sessionId = 'sess-sched-0001'
const session = {
  id: sessionId,
  events: [
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '跑一遍调度测试' }] } }, time: Date.now() - 9_000 },
    { type: 'turn/start', data: { turn: 4 }, time: Date.now() - 8_000 },
    { type: 'step/start', data: { turn: 4, step: 1 }, time: Date.now() - 7_000 },
    { type: 'tool/result', data: { turn: 4, toolName: 'ops_bash' }, time: Date.now() - 6_000 },
    {
      type: 'assistant/message',
      data: {
        turn: 4,
        step: 1,
        message: { content: [{ type: 'text', text: '## 做了什么\n- 跑通了调度\n\n## 下一步计划\n- 观察真实投递' }] },
        usage: { inputTokens: 500, outputTokens: 120 },
      },
      time: Date.now() - 2_000,
    },
    { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } }, time: Date.now() - 1_000 },
  ],
}

const record = { value: undefined }
const services = {
  credentials: {
    async readRecord() { return record.value },
    async modifyRecord(_key, mutate) {
      record.value = await mutate(record.value)
      return record.value
    },
  },
  sessions: {
    get(id) { return id === sessionId ? session : undefined },
    list() { return [session] },
  },
  sessionTitle: { get() { return { title: '调度测试会话' } } },
  workingDirectory: { get() { return 'F:\\repo' } },
}

const routes = []
const ctx = {
  get(name) { return services[name] },
  on() { return () => undefined },
  effect(run) { return run() },
  webServer: { register(route) { routes.push(route); return () => undefined } },
  connection: { requestRejection() { return undefined } },
  logger: { info() {}, warn() {} },
}

apply(ctx)

function request(method, path, body) {
  const route = routes.find(entry => path.startsWith(entry.path))
  if (route === undefined) throw new Error(`no route for ${path}`)
  return new Promise((resolve) => {
    const req = {
      method,
      url: path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
      },
    }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) { this.headers[key] = value },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }) },
    }
    void route.handler(req, res)
  })
}

const stored = () => record.value?.payload ?? {}

let failures = 0
function check(label, ok, detail) {
  if (ok) {
    console.log(`ok   ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : `\n     ${JSON.stringify(detail)}`}`)
  }
}

// --- account -------------------------------------------------------------
const saved = await request('POST', '/session-mail-notifier/settings', {
  bindEmail: 'sender@example.com',
  smtpHost: '127.0.0.1',
  smtpPort: port,
  smtpSecure: false,
  smtpUser: 'sender@example.com',
  smtpPass: 'auth-code',
  notifyTo: 'target@example.com',
  subjectPrefix: '[DSH]',
  enabled: true,
  template: 'structured',
  includeMetrics: true,
  failureAlerts: true,
  retryLimit: 2,
  retryBaseMs: 5_000,
})
check('settings saved', saved.body?.ok === true, saved.body)

// --- 1. failure goes to the retry queue, then arrives ---------------------
failNextData = true
const refused = await request('POST', '/session-mail-notifier/report', { id: sessionId })
check('refused report is reported as failure', refused.body?.ok === false, refused.body)
check('outbox holds the message', stored().outbox?.length === 1, stored().outbox)
check('history marks it queued', stored().history?.at(-1)?.queued === true, stored().history?.at(-1))

const flushed = await request('POST', '/session-mail-notifier/queue', { action: 'flush' })
check('flush retried the message', flushed.body?.retried === 1, flushed.body)
check('outbox is empty after a successful retry', stored().outbox?.length === 0, stored().outbox)
check('the retried mail arrived', mailboxes.length === 1 && mailboxes[0].subject.includes('调度测试会话'), mailboxes.map(mail => mail.subject))
check('the retried mail kept its template', mailboxes[0]?.body.includes('一、做了什么') === true && mailboxes[0]?.body.includes('下一步计划') === true)

// --- 2. quiet hours hold the report, then summarise -----------------------
const quiet = await request('POST', '/session-mail-notifier/settings', {
  quiet: { enabled: true, from: '00:00', to: '23:59' },
})
check('quiet window saved', quiet.body?.settings?.quiet?.enabled === true, quiet.body?.settings?.quiet)

const held = await request('POST', '/session-mail-notifier/report', { id: sessionId })
check('quiet report is deferred', held.body?.ok === false, held.body)
check('deferred list holds one item', stored().deferred?.length === 1, stored().deferred)
check('nothing was delivered while quiet', mailboxes.length === 1, mailboxes.length)

await request('POST', '/session-mail-notifier/settings', { quiet: { enabled: false, from: '22:00', to: '08:00' } })
const summary = await request('POST', '/session-mail-notifier/queue', { action: 'flush' })
check('flush summarised the deferred items', summary.body?.flushed === 1, summary.body)
check('deferred list is empty', stored().deferred?.length === 0, stored().deferred)
check('the summary mail arrived', mailboxes.length === 2 && mailboxes[1].subject.includes('静默期汇总'), mailboxes.map(mail => mail.subject))

// --- 3. the daily digest -------------------------------------------------
await request('POST', '/session-mail-notifier/settings', { digest: { enabled: true, at: '00:00' } })
const buffered = stored().digestBuffer?.length ?? 0
check('successful reports were buffered for the digest', buffered >= 1, stored().digestBuffer)

const digested = await request('POST', '/session-mail-notifier/queue', { action: 'flush' })
check('digest fired', digested.body?.digest === true, digested.body)
check('the digest mail arrived', mailboxes.length === 3 && mailboxes[2].subject.includes('日报'), mailboxes.map(mail => mail.subject))
check('digest buffer cleared', stored().digestBuffer?.length === 0, stored().digestBuffer)
check('digest records its slot', typeof stored().digest?.lastAt === 'number', stored().digest)

server.close()
console.log(failures === 0 ? '\nPASS: scheduler' : `\nFAIL: ${failures} assertion(s)`)
if (failures > 0) process.exitCode = 1
