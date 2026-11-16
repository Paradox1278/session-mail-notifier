/**
 * Minimal dependency-free SMTP submission client.
 *
 * Supports implicit TLS (465), STARTTLS (587 / 25) and plaintext, AUTH LOGIN /
 * AUTH PLAIN, UTF-8 subjects (RFC 2047) and UTF-8 base64 bodies. Written with
 * node:net + node:tls only so the bundle needs no install script or dependency.
 */

import net from 'node:net'
import tls from 'node:tls'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

/** One parsed SMTP reply: numeric code plus the text lines beside it. */
class SmtpReply {
  constructor(code, lines) {
    this.code = code
    this.lines = lines
  }

  get text() {
    return this.lines.join(' ')
  }
}

/** Split `buffer` at the end of the first complete (possibly multiline) reply. */
function responseEnd(buffer) {
  let cursor = 0
  while (cursor < buffer.length) {
    const newline = buffer.indexOf('\n', cursor)
    if (newline < 0) return -1
    const line = buffer.slice(cursor, newline + 1)
    cursor = newline + 1
    if (/^\d{3} /.test(line)) return cursor
  }
  return -1
}

/** Read one reply out of a channel's buffer, keeping anything after it. */
function parseReply(block) {
  const lines = block.split(/\r?\n/).filter(line => line.length > 0)
  const code = Number.parseInt(lines[0]?.slice(0, 3) ?? '0', 10)
  return new SmtpReply(
    Number.isFinite(code) ? code : 0,
    lines.map(line => line.slice(4)),
  )
}

/**
 * Line-oriented reader over one socket. `read()` resolves with the next reply;
 * a socket error or close rejects every waiter, so a dead connection can never
 * hang a send.
 */
function createChannel(socket) {
  let buffer = ''
  let failure = null
  const waiters = []

  const settle = () => {
    while (waiters.length > 0) {
      const end = responseEnd(buffer)
      if (end < 0) return
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end)
      const waiter = waiters.shift()
      waiter.resolve(parseReply(block))
    }
  }

  const onData = (chunk) => {
    buffer += chunk.toString('utf8')
    settle()
  }
  const onError = (error) => {
    failure = error
    while (waiters.length > 0) waiters.shift().reject(error)
  }
  const onClose = () => {
    onError(failure ?? new Error('SMTP 连接已被服务器关闭'))
  }

  socket.on('data', onData)
  socket.on('error', onError)
  socket.on('close', onClose)

  return {
    read() {
      if (failure !== null) return Promise.reject(failure)
      const ready = responseEnd(buffer)
      if (ready >= 0) {
        const block = buffer.slice(0, ready)
        buffer = buffer.slice(ready)
        return Promise.resolve(parseReply(block))
      }
      return new Promise((resolve, reject) => { waiters.push({ resolve, reject }) })
    },
    /** Stop owning the socket so it can be handed to `tls.connect`. */
    detach() {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    },
  }
}

/** One SMTP command: write `line`, then demand an expected reply code. */
async function command(channel, socket, line, expected, label) {
  socket.write(`${line}\r\n`)
  const reply = await channel.read()
  if (!expected.includes(reply.code)) {
    throw new Error(`${label} 失败：服务器返回 ${reply.code} ${reply.text}`.trim())
  }
  return reply
}

/** Open the TCP / TLS connection and wait for the 220 greeting. */
async function openConnection({ host, port, secure, timeoutMs }) {
  const socket = secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
    : net.connect({ host, port })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连接 ${host}:${port} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('error', onError)
      socket.removeListener('connect', onConnect)
      socket.removeListener('secureConnect', onConnect)
    }
    function onError(error) {
      cleanup()
      reject(error)
    }
    function onConnect() {
      cleanup()
      resolve()
    }
    socket.once('error', onError)
    socket.once(secure ? 'secureConnect' : 'connect', onConnect)
  })

  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP 会话超时')))
  return socket
}

/** Wrap an existing socket in a TLS session after STARTTLS. */
function startTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: host }, () => resolve(secured))
    secured.once('error', reject)
  })
}

/** RFC 2047 encoded word for a header value. */
function encodeHeader(value) {
  const text = String(value)
  if (/^[\x20-\x7e]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

/** RFC 5322 date in UTC form, which every server accepts. */
function mailDate() {
  return new Date().toUTCString().replace(/GMT$/, '+0000')
}

/** 76-column base64 body with dot-stuffing applied per line. */
function encodeBody(text) {
  const base64 = Buffer.from(String(text), 'utf8').toString('base64')
  const lines = base64.match(/.{1,76}/g) ?? ['']
  return lines.map(line => (line.startsWith('.') ? `.${line}` : line)).join('\r\n')
}

/** Extract the AUTH mechanisms an EHLO reply advertises. */
function authMechanisms(lines) {
  const line = lines.find(entry => /^\s*AUTH[ =]/i.test(entry))
  if (line === undefined) return []
  return line.replace(/^\s*AUTH[ =]\s*/i, '').split(/\s+/).filter(Boolean).map(part => part.toUpperCase())
}

/** Which provider's credential rules apply to this SMTP host. */
function providerOf(host) {
  const value = String(host ?? '').toLowerCase()
  if (value.includes('qq.com') || value.includes('foxmail')) return 'qq'
  if (value.includes('163.com') || value.includes('126.com') || value.includes('yeah.net')) return 'netease'
  if (value.includes('gmail') || value.includes('googlemail')) return 'gmail'
  if (value.includes('office365') || value.includes('outlook') || value.includes('hotmail')) return 'outlook'
  if (value.includes('aliyun') || value.includes('mxhichina')) return 'aliyun'
  return 'generic'
}

const PROVIDER_HELP = {
  netease: '163 / 126 邮箱必须用「客户端授权码」，用网页登录密码一定返回 535。获取方式：网页登录邮箱 → 设置 → POP3/SMTP/IMAP → 先开启「SMTP 服务」→ 再点「新增授权密码」，得到 16 位授权码（形如 ABCD1234EFGH5678）。',
  qq: 'QQ 邮箱必须用「授权码」，不是 QQ 密码。获取方式：mail.qq.com → 设置 → 账户 → POP3/IMAP/SMTP 服务 → 开启 SMTP 服务 → 生成授权码（可能要短信验证），得到 16 位字母数字。',
  gmail: 'Gmail 需要「应用专用密码」：先开启两步验证，再在「应用专用密码」里生成 16 位密码填进授权码栏；账号密码会被拒绝。',
  outlook: 'Outlook / Microsoft 365 需要「应用密码」，且租户要允许 SMTP AUTH；端口用 587 + STARTTLS（465 常被拒）。',
  aliyun: '阿里云邮箱 / 企业邮箱用「客户端专用密码」，在网页端设置里生成，用户名写完整邮箱地址。',
  generic: '确认填的是服务商提供的「客户端授权码 / 应用密码」而不是网页登录密码，用户名写完整邮箱地址。',
}

/**
 * Turn a bare `535` into something a user can act on.
 * The server text is kept verbatim, then the provider rules are appended.
 */
function authFailure(host, port, secure, error, user, pass) {
  const raw = error instanceof Error ? error.message : String(error)
  const kind = providerOf(host)
  const help = PROVIDER_HELP[kind]
  const portHint = secure
    ? `当前 ${port} + SSL/TLS`
    : `当前 ${port} + STARTTLS`
  const lines = [raw, help]

  const account = String(user ?? '').trim()
  const code = String(pass ?? '').trim()

  // The most common 535 is not a wrong code: it is a login name that is not the
  // mailbox address. Providers take AUTH user verbatim as the account, so a
  // display name, an alias without the domain, or a QQ number fails while the
  // code itself is perfectly valid.
  if (account.length === 0) {
    lines.push('SMTP 用户名为空：请把它填成完整邮箱地址（例如 you@163.com），授权码只放在密码栏。')
  } else if (!account.includes('@')) {
    lines.push(`SMTP 用户名「${account}」不是邮箱地址 —— 服务器会拿它当账号去核对，授权码再正确也会返回 535。请把用户名改成完整邮箱地址（${account}@${host.replace(/^smtp\./u, '')} 之类），授权码保持在密码栏。`)
  } else if (code.length === 0) {
    lines.push('授权码为空：邮箱服务商不接受网页登录密码，需要单独生成客户端授权码。')
  } else if (/^\s|\s$/u.test(String(pass ?? ''))) {
    lines.push('授权码首尾带空白字符：复制时容易带入空格或换行，删掉后再试。')
  } else if (kind !== 'generic' && code.length !== 16) {
    lines.push(`授权码长度是 ${code.length} 位，${kind === 'qq' ? 'QQ 邮箱' : '163 / 126 / 阿里'} 通常是 16 位。若长度不符，确认复制的是「客户端授权码」而不是网页登录密码。`)
  }

  lines.push(`再核对：绑定邮箱与 SMTP 用户名是同一个地址；改过邮箱登录密码后授权码会立即失效，需重新生成；端口与加密要匹配（465 = SSL/TLS，587 = STARTTLS）。${portHint}。`)
  return lines.join('\n')
}

/**
 * Deliver one plain-text message through an authenticated SMTP submission.
 *
 * @returns the server's final reply text for the DATA stage.
 */
export async function sendMail(options) {
  const {
    host, port, secure, user, pass, from, fromName, to, subject, text,
    timeoutMs = 25_000, ehloName = os.hostname() || 'localhost',
  } = options

  if (!host) throw new Error('缺少 SMTP 服务器地址')
  if (!from) throw new Error('缺少发件邮箱')
  if (!to) throw new Error('缺少收件邮箱')

  let socket = await openConnection({ host, port, secure, timeoutMs })
  let channel = createChannel(socket)
  let authSeen = false

  try {
    const greeting = await channel.read()
    if (greeting.code !== 220) {
      throw new Error(`服务器未接受连接：${greeting.code} ${greeting.text}`.trim())
    }

    let ehlo = await command(channel, socket, `EHLO ${ehloName}`, [250], 'EHLO')
    let mechanisms = authMechanisms(ehlo.lines)

    if (!secure && !authSeen) {
      const offersStartTls = ehlo.lines.some(line => /^\s*STARTTLS\s*$/i.test(line))
      if (offersStartTls) {
        await command(channel, socket, 'STARTTLS', [220], 'STARTTLS')
        channel.detach()
        socket = await startTls(socket, host)
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP 会话超时')))
        channel = createChannel(socket)
        ehlo = await command(channel, socket, `EHLO ${ehloName}`, [250], 'EHLO (TLS)')
        mechanisms = authMechanisms(ehlo.lines)
        authSeen = true
      }
    }

    if (user && pass) {
      try {
        if (mechanisms.includes('LOGIN') || mechanisms.length === 0) {
          await command(channel, socket, 'AUTH LOGIN', [334], 'AUTH LOGIN')
          await command(channel, socket, Buffer.from(user, 'utf8').toString('base64'), [334], 'AUTH 用户名')
          await command(channel, socket, Buffer.from(pass, 'utf8').toString('base64'), [235], 'AUTH 密码')
        } else if (mechanisms.includes('PLAIN')) {
          const token = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64')
          await command(channel, socket, `AUTH PLAIN ${token}`, [235], 'AUTH PLAIN')
        } else {
          throw new Error(`服务器只支持 AUTH ${mechanisms.join('/')}，本插件支持 LOGIN 与 PLAIN`)
        }
      } catch (error) {
        throw new Error(authFailure(host, port, secure, error, user, pass))
      }
    }

    await command(channel, socket, `MAIL FROM:<${from}>`, [250], 'MAIL FROM')
    await command(channel, socket, `RCPT TO:<${to}>`, [250, 251], 'RCPT TO')
    await command(channel, socket, 'DATA', [354], 'DATA')

    const headers = [
      `From: ${fromName ? `${encodeHeader(fromName)} ` : ''}<${from}>`,
      `To: <${to}>`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${mailDate()}`,
      `Message-ID: <${randomUUID()}@${host}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
    ]
    const payload = `${headers.join('\r\n')}\r\n${encodeBody(text)}\r\n.\r\n`
    socket.write(payload)
    const delivered = await channel.read()
    if (delivered.code !== 250) {
      throw new Error(`服务器拒收邮件：${delivered.code} ${delivered.text}`.trim())
    }
    await command(channel, socket, 'QUIT', [221], 'QUIT').catch(() => undefined)
    return delivered.text || '250 OK'
  } finally {
    channel.detach()
    socket.destroy()
  }
}
