/**
 * Local loopback harness for smtp.js: a scripted SMTP server that speaks
 * EHLO / AUTH LOGIN / MAIL / RCPT / DATA, so delivery is verified without a
 * real mailbox.
 */

import net from 'node:net'
import { sendMail } from '../smtp.js'

const received = []

const server = net.createServer((socket) => {
  let buffer = ''
  let phase = 'command' // command | data | auth-user | auth-pass
  let dataLines = []
  socket.write('220 test.local ESMTP ready\r\n')

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (;;) {
      if (phase === 'data') {
        const end = buffer.indexOf('\r\n.\r\n')
        if (end < 0) return
        dataLines.push(buffer.slice(0, end))
        buffer = buffer.slice(end + 5)
        received.push(dataLines.join('\r\n'))
        dataLines = []
        phase = 'command'
        socket.write('250 2.0.0 stored\r\n')
        continue
      }
      const newline = buffer.indexOf('\r\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 2)

      if (phase === 'auth-user') {
        phase = 'auth-pass'
        socket.write('334 UGFzc3dvcmQ6\r\n')
        continue
      }
      if (phase === 'auth-pass') {
        phase = 'command'
        socket.write('235 2.7.0 accepted\r\n')
        continue
      }

      const upper = line.toUpperCase()
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        socket.write('250-test.local\r\n250-AUTH LOGIN PLAIN\r\n250-8BITMIME\r\n250 OK\r\n')
      } else if (upper === 'AUTH LOGIN') {
        phase = 'auth-user'
        socket.write('334 VXNlcm5hbWU6\r\n')
      } else if (upper.startsWith('AUTH PLAIN')) {
        socket.write('235 2.7.0 accepted\r\n')
      } else if (upper.startsWith('MAIL FROM')) {
        socket.write('250 2.1.0 ok\r\n')
      } else if (upper.startsWith('RCPT TO')) {
        socket.write('250 2.1.5 ok\r\n')
      } else if (upper === 'DATA') {
        phase = 'data'
        socket.write('354 end with <CRLF>.<CRLF>\r\n')
      } else if (upper === 'QUIT') {
        socket.write('221 bye\r\n')
        socket.end()
      } else {
        socket.write('250 ok\r\n')
      }
    }
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log('test smtp listening on', port)

const info = await sendMail({
  host: '127.0.0.1',
  port,
  secure: false,
  user: 'sender@example.com',
  pass: 'auth-code',
  from: 'sender@example.com',
  fromName: 'DSH 任务汇报',
  to: 'target@example.com',
  subject: '[DSH] 任务完成：测试会话',
  text: '第一行\n第二行 中文正文',
})
console.log('sendMail resolved:', info)

server.close()

const raw = received[0] ?? ''
const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')
const decoded = Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')
const subjectLine = raw.split('\r\n').find(line => line.startsWith('Subject:')) ?? ''
const fromLine = raw.split('\r\n').find(line => line.startsWith('From:')) ?? ''
const toLine = raw.split('\r\n').find(line => line.startsWith('To:')) ?? ''

console.log('subject header:', subjectLine)
console.log('subject decoded:', Buffer.from(subjectLine.replace(/^Subject: =\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8'))
console.log('from header:', fromLine)
console.log('to header:', toLine)
console.log('body decoded:', JSON.stringify(decoded))
console.log('PASS:', decoded === '第一行\n第二行 中文正文'
  && subjectLine.includes('=?UTF-8?B?')
  && toLine === 'To: <target@example.com>'
  && fromLine.includes('<sender@example.com>'))
