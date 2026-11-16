/**
 * Host-half harness: mounts index.js against a fake Cordis context and a
 * scripted SMTP server, then proves the whole chain — save settings with
 * verification, watch a Session, and receive the automatic completion report
 * when `agent/status` goes running → idle.
 */

import net from 'node:net'
import { apply } from '../index.js'

const mailboxes = []

/** One scripted SMTP server on an ephemeral loopback port. */
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
        else if (upper === 'DATA') { phase = 'data'; socket.write('354 go\r\n') }
        else if (upper === 'QUIT') { socket.write('221 bye\r\n'); socket.end() }
        else socket.write('250 ok\r\n')
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

/** Decode the headers we assert on plus the base64 body. */
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
    from: headers.from ?? '',
    body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8'),
  }
}

const { server, port } = await startSmtp()
console.log('fake smtp on', port)

// --- one finished turn in a watched Session -------------------------------
const sessionId = 'sess-test-0001'
const session = {
  id: sessionId,
  events: [
    { type: 'turn/start', data: { turn: 3 }, time: Date.now() - 5_000 },
    { type: 'user/message', data: { content: [{ type: 'text', text: '帮我整理季度报告' }] }, time: Date.now() - 4_000 },
    { type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '报告已生成：report-q4.md，共 12 页。' }] } }, time: Date.now() - 1_000 },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'success' } }, time: Date.now() - 500 },
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
  sessionTitle: { get() { return { title: '季度报告整理' } } },
  workingDirectory: { get() { return 'F:\\work\\demo' } },
}

const routes = []
const listeners = new Map()
const ctx = {
  get(name) { return services[name] },
  on(name, handler) {
    const bucket = listeners.get(name) ?? []
    bucket.push(handler)
    listeners.set(name, bucket)
    return () => undefined
  },
  effect(run) { const dispose = run(); return dispose },
  webServer: { register(route) { routes.push(route); return () => undefined } },
  connection: { requestRejection() { return undefined } },
  logger: { info() {}, warn() {} },
}

apply(ctx)
console.log('routes registered:', routes.map(route => `${route.kind} ${route.path}`))

/** Drive one route the way the browser does. */
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

const save = await request('POST', '/session-mail-notifier/settings', {
  bindEmail: 'sender@example.com',
  smtpHost: '127.0.0.1',
  smtpPort: port,
  smtpSecure: false,
  smtpUser: 'sender@example.com',
  smtpPass: 'auth-code',
  notifyTo: 'target@example.com',
  subjectPrefix: '[DSH] 任务完成',
  includeSummary: true,
  verify: true,
})
console.log('save+verify:', save.status, JSON.stringify(save.body).slice(0, 200))

const watch = await request('POST', '/session-mail-notifier/watch', { id: sessionId, title: '季度报告整理', watch: true })
console.log('watch:', watch.status, watch.body?.settings?.watches)

for (const status of ['running', 'idle']) {
  for (const handler of listeners.get('agent/status') ?? []) handler({ agent: { session }, status })
  await new Promise(resolve => setTimeout(resolve, 60))
}
await new Promise(resolve => setTimeout(resolve, 1_800))

const state = await request('GET', '/session-mail-notifier/state')
console.log('state watches:', state.body?.settings?.watches)
console.log('history:', JSON.stringify(state.body?.settings?.history))

server.close()

console.log('\n--- mailboxes ---')
mailboxes.forEach((mail, index) => {
  console.log(`#${index + 1} subject=${mail.subject}`)
  console.log(`    to=${mail.to}`)
  console.log(`    body=${mail.body.replace(/\n/g, ' | ').slice(0, 220)}`)
})

const verifyMail = mailboxes[0]
const reportMail = mailboxes[1]
const pass = mailboxes.length === 2
  && verifyMail.subject.includes('绑定验证')
  && reportMail.subject.includes('季度报告整理')
  && reportMail.body.includes('sessionId'.replace('sessionId', sessionId))
  && reportMail.body.includes('报告已生成')
  && reportMail.body.includes('turn 3')
  && reportMail.body.includes('正常完成')

console.log('\nPASS:', pass)
