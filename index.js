/**
 * Host half of the session mail notifier.
 *
 * Owns four things: the settings document (see `store.js`, one credential
 * record), SMTP delivery (see `smtp.js`, no dependencies), report composition
 * (see `report.js`, pure templates) and delivery scheduling (see `queue.js`,
 * pure rules for retry, quiet hours and the daily digest). This file only wires
 * those pieces to a live Session and to the web routes the page calls.
 *
 * Delivery has three destinations rather than one:
 *
 *   - straight to the SMTP server, when the account is verified and nothing holds it;
 *   - the durable retry queue, when SMTP refuses a message;
 *   - the deferred list, when the clock is inside a quiet window.
 *
 * Every path ends with a record in `history`, so a message that was queued or
 * held is still visible in the page instead of silently disappearing.
 */

import { sendMail } from './smtp.js'
import { loadSettings, saveSettings, storageBackend } from './store.js'
import {
  analyzeTurn,
  buildDeferredSummary,
  buildDigest,
  buildReport,
  isFailure,
  reasonLabel,
  stamp,
} from './report.js'
import {
  digestDue,
  dueJobs,
  enqueue,
  isQuiet,
  quietEndsAt,
  retryAt,
  sameDay,
} from './queue.js'

/** Route prefix owned by this plugin; no other plugin may claim it. */
export const ROUTE_PREFIX = '/session-mail-notifier'

/** The route carrier and the trust fence in front of it. */
export const inject = ['webServer', 'connection']

/** How long to wait for the turn's events to reach the log before reporting. */
const SETTLE_MS = 1_200

/** How often the scheduler looks for retries, quiet-hour flushes and digests. */
const TICK_MS = 30_000

/** How many delivered reports are kept for the page. */
const HISTORY_LIMIT = 50

const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms) })

/** Answer one request with JSON. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/** Read a bounded JSON request body. */
async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/** Everything the page is allowed to see; the authorization code never leaves the Host. */
function publicView(settings, ctx) {
  const outbox = Array.isArray(settings.outbox) ? settings.outbox : []
  const deferred = Array.isArray(settings.deferred) ? settings.deferred : []
  const buffered = Array.isArray(settings.digestBuffer) ? settings.digestBuffer : []
  return {
    enabled: settings.enabled,
    bindEmail: settings.bindEmail,
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpSecure: settings.smtpSecure,
    smtpUser: settings.smtpUser,
    hasPass: settings.smtpPass.length > 0,
    notifyTo: settings.notifyTo,
    subjectPrefix: settings.subjectPrefix,
    includeSummary: settings.includeSummary,
    summaryChars: settings.summaryChars,
    template: settings.template,
    includeMetrics: settings.includeMetrics,
    failureAlerts: settings.failureAlerts,
    retryLimit: settings.retryLimit,
    retryBaseMs: settings.retryBaseMs,
    quiet: settings.quiet,
    digest: settings.digest,
    watches: settings.watches,
    verifiedAt: settings.verifiedAt,
    lastSent: settings.lastSent,
    history: settings.history.slice(-20).reverse(),
    queue: {
      pending: outbox.length,
      deferred: deferred.length,
      buffered: buffered.length,
      outbox: outbox.slice(-3).map(entry => ({
        id: entry.id,
        attempts: entry.attempts,
        nextAt: entry.nextAt,
        subject: entry.subject,
        lastError: entry.lastError,
      })),
      deferredItems: deferred.slice(-3).map(entry => ({ at: entry.at, title: entry.title, reason: entry.reason })),
    },
    storage: storageBackend(ctx),
  }
}

/**
 * The event list of a live Session.
 *
 * A real Session exposes `snapshotEvents()`; a plain array under `events` is
 * what test doubles and older containers provide, so both are accepted.
 */
function eventsOf(session) {
  if (Array.isArray(session?.events)) return session.events
  if (typeof session?.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    } catch {
      return []
    }
  }
  if (typeof session?.ownEvents === 'function') {
    try {
      const events = session.ownEvents()
      return Array.isArray(events) ? events : []
    } catch {
      return []
    }
  }
  return []
}

/** The newest finished turn in this Session, or null when it never finished one. */
function lastTurn(session) {
  const events = eventsOf(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== null && typeof event === 'object'
      && event.type === 'turn/end' && typeof event.data?.turn === 'number') {
      return event.data.turn
    }
  }
  return null
}

/** Session title from the log-backed fold, with the session id as the floor. */
function titleOf(ctx, session) {
  const titleService = ctx.get('sessionTitle')
  if (titleService !== undefined && titleService !== null && typeof titleService.get === 'function') {
    try {
      const snapshot = titleService.get(session)
      const title = snapshot?.title ?? snapshot?.text
      if (typeof title === 'string' && title.length > 0) return title
    } catch {
      // A title fold failure is never a reason to lose the report.
    }
  }
  return ''
}

/** Effective working directory of one session, when the service exposes it. */
function cwdOf(ctx, session) {
  const directory = ctx.get('workingDirectory')
  if (directory !== undefined && directory !== null && typeof directory.get === 'function') {
    try {
      const value = directory.get(session)
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // Absent directory is a detail, not a failure.
    }
  }
  const header = session?.header
  if (header !== undefined && typeof header?.cwd === 'string') return header.cwd
  return ''
}

/** Deliver one message with the saved account; never throws. */
async function deliver(ctx, settings, { to, subject, text }) {
  void ctx
  if (settings.bindEmail.length === 0) return { ok: false, error: '尚未绑定发件邮箱' }
  if (settings.smtpHost.length === 0) return { ok: false, error: '尚未填写 SMTP 服务器' }
  const target = (to ?? settings.notifyTo ?? '').trim()
  if (target.length === 0) return { ok: false, error: '尚未填写汇报目标邮箱' }
  if (settings.smtpPass.length === 0) return { ok: false, error: '尚未填写 SMTP 授权码' }

  try {
    const info = await sendMail({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.smtpSecure,
      user: settings.smtpUser.length > 0 ? settings.smtpUser : settings.bindEmail,
      pass: settings.smtpPass,
      from: settings.bindEmail,
      fromName: 'DSH 任务汇报',
      to: target,
      subject,
      text,
    })
    return { ok: true, to: target, info }
  } catch (error) {
    return { ok: false, to: target, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Register the routes, the watcher, the scheduler, and their disposal. */
export function apply(ctx, config = {}) {
  void config
  let cached = null
  let writeChain = Promise.resolve()
  let ticking = false

  const settings = async () => {
    if (cached === null) cached = (await loadSettings(ctx)).settings
    return cached
  }

  /** Serialize read-modify-write cycles so two reports cannot drop each other. */
  const mutate = (change) => {
    const run = async () => {
      const current = await settings()
      const next = change(current)
      await saveSettings(ctx, next)
      cached = (await loadSettings(ctx)).settings
      return cached
    }
    const queued = writeChain.then(run, run)
    writeChain = queued.catch(() => undefined)
    return queued
  }

  /** Every live session the page may watch, newest first. */
  const liveSessions = () => {
    const store = ctx.get('sessions')
    const list = store !== undefined && store !== null && typeof store.list === 'function' ? store.list() : []
    return list.map((session) => {
      const events = eventsOf(session)
      const last = events[events.length - 1]
      return {
        id: session.id,
        title: titleOf(ctx, session),
        cwd: cwdOf(ctx, session),
        updatedAt: typeof last?.time === 'number' ? last.time : null,
      }
    }).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  /** Watches decorated with the live title and activity the page cannot derive. */
  const describeWatches = (current, sessions = liveSessions()) => {
    const byId = new Map(sessions.map(session => [session.id, session]))
    return current.watches.map((entry) => {
      const live = byId.get(entry.id)
      return {
        id: entry.id,
        title: entry.title.length > 0 ? entry.title : (live?.title ?? ''),
        addedAt: entry.addedAt,
        live: live !== undefined,
      }
    })
  }

  /** Record one delivery attempt in `history` and, on success, in the digest buffer. */
  const record = async (entry) => {
    await mutate((latest) => {
      const next = { ...latest }
      next.history = [...latest.history, entry].slice(-HISTORY_LIMIT)
      if (entry.ok === true && entry.buffered === true) {
        next.digestBuffer = [...latest.digestBuffer, {
          at: entry.at,
          sessionId: entry.sessionId,
          title: entry.title,
          turn: entry.turn,
          reason: entry.reason,
          durationMs: entry.durationMs,
          ok: entry.reason === null ? true : !isFailure(entry.reason),
          error: entry.error,
        }].slice(-200)
      }
      return next
    })
  }

  /**
   * Choose a destination for one message: send now, hold for quiet hours, or
   * queue for retry. The caller keeps the returned verdict for the page.
   */
  const route = async (current, message, meta) => {
    const now = Date.now()
    if (isQuiet(current.quiet, now)) {
      const until = quietEndsAt(current.quiet, now)
      await mutate((latest) => ({
        ...latest,
        deferred: [...latest.deferred, {
          at: meta.at ?? now,
          sessionId: meta.sessionId,
          title: meta.title ?? '',
          turn: meta.turn ?? null,
          reason: meta.reason ?? null,
          durationMs: meta.durationMs ?? null,
          ok: meta.ok ?? true,
          error: meta.error,
        }].slice(-50),
      }))
      return { ok: false, deferred: true, until, error: '处于静默时段，已暂存到静默结束后汇总发送' }
    }

    const result = await deliver(ctx, current, message)
    if (result.ok) return result

    const job = {
      id: meta.id ?? `${meta.sessionId ?? 'msg'}:${now}`,
      kind: meta.kind ?? 'report',
      to: result.to ?? current.notifyTo,
      subject: message.subject,
      text: message.text,
      attempts: 0,
      createdAt: now,
      nextAt: retryAt(1, current.retryBaseMs, now),
      sessionId: meta.sessionId,
      title: meta.title,
      turn: meta.turn ?? null,
      reason: meta.reason ?? null,
      durationMs: meta.durationMs ?? null,
      lastError: result.error,
    }
    await mutate((latest) => ({ ...latest, outbox: enqueue(latest.outbox, job, now) }))
    return { ...result, queued: true, nextAt: job.nextAt }
  }

  /** Report one finished turn to the watched address. */
  const report = async (session, sessionId, options = {}) => {
    const current = await settings()
    const watch = current.watches.find(entry => entry.id === sessionId)
    const forced = options.force === true
    if (!forced && watch === undefined) return { ok: false, error: '该会话未被监视' }
    if (!forced && !current.enabled) return { ok: false, error: '汇报已关闭' }

    const turn = options.turn ?? lastTurn(session)
    if (!forced && turn !== null && current.lastSent[sessionId]?.turn === turn) {
      return { ok: false, skipped: true, error: `turn ${turn} 已汇报过` }
    }

    const analysis = analyzeTurn({ events: eventsOf(session) }, turn)
    const failure = isFailure(analysis.reason)
    if (!forced && failure && current.failureAlerts !== true) {
      return { ok: false, skipped: true, error: '失败专报已关闭，本轮不发送' }
    }

    const title = titleOf(ctx, session) || (watch?.title ?? '')
    const at = analysis.finishedAt ?? Date.now()
    const built = buildReport(current, {
      sessionId,
      title,
      cwd: cwdOf(ctx, session),
      analysis,
      at,
    })

    const result = await route(current, { subject: built.subject, text: built.text }, {
      id: `${sessionId}:${turn ?? at}`,
      kind: failure ? 'failure' : 'report',
      sessionId,
      title,
      turn,
      reason: analysis.reason,
      durationMs: analysis.durationMs ?? null,
      ok: !failure,
      at,
    })

    await record({
      at: Date.now(),
      sessionId,
      title,
      to: result.to ?? current.notifyTo,
      ok: result.ok === true,
      deferred: result.deferred === true,
      queued: result.queued === true,
      error: result.ok ? undefined : result.error,
      turn,
      reason: analysis.reason,
      durationMs: analysis.durationMs ?? null,
      buffered: result.ok === true && !failure,
    })

    if (result.ok) {
      await mutate((latest) => ({
        ...latest,
        lastSent: { ...latest.lastSent, [sessionId]: { turn, at: Date.now() } },
        verifiedAt: latest.verifiedAt ?? Date.now(),
      }))
    }
    return result
  }

  /**
   * One scheduler pass: flush held messages when quiet hours ended, retry what
   * SMTP refused, and send the daily digest when its clock time has passed.
   */
  const tick = async (options = {}) => {
    if (ticking) return { ok: true, skipped: true }
    ticking = true
    try {
      const current = await settings()
      const now = Date.now()
      const done = { flushed: 0, retried: 0, digest: false }

      if (!isQuiet(current.quiet, now) && current.deferred.length > 0) {
        const items = current.deferred
        const built = buildDeferredSummary(current, { items, at: now })
        const result = await deliver(ctx, current, built)
        if (result.ok) {
          await mutate((latest) => ({ ...latest, deferred: [] }))
          done.flushed = items.length
        }
      }

      const latest = await settings()
      // A manual flush means "try now": the backoff only paces the unattended
      // scheduler, it must never stop the owner from pushing a stuck mail out.
      const jobs = options.force === true
        ? (Array.isArray(latest.outbox) ? [...latest.outbox] : [])
        : dueJobs(latest.outbox, Date.now())
      for (const job of jobs) {
        const result = await deliver(ctx, latest, { to: job.to, subject: job.subject, text: job.text })
        if (result.ok) {
          await mutate((state) => ({ ...state, outbox: state.outbox.filter(entry => entry.id !== job.id) }))
          await record({
            at: Date.now(),
            sessionId: job.sessionId,
            title: job.title,
            to: job.to,
            ok: true,
            turn: job.turn ?? null,
            reason: job.reason ?? null,
            durationMs: job.durationMs ?? null,
            buffered: isFailure(job.reason) === false,
          })
          done.retried += 1
          continue
        }
        const attempts = (job.attempts ?? 0) + 1
        if (attempts > latest.retryLimit) {
          await mutate((state) => ({ ...state, outbox: state.outbox.filter(entry => entry.id !== job.id) }))
          await record({
            at: Date.now(),
            sessionId: job.sessionId,
            title: job.title,
            to: job.to,
            ok: false,
            error: `重试 ${latest.retryLimit} 次后放弃：${result.error}`,
          })
          continue
        }
        await mutate((state) => ({
          ...state,
          outbox: enqueue(state.outbox, {
            ...job,
            attempts,
            nextAt: retryAt(attempts, state.retryBaseMs, Date.now()),
            lastError: result.error,
          }, Date.now()),
        }))
      }

      const after = await settings()
      const buffer = sameDay(after.digestBuffer, Date.now())
      if (digestDue(after.digest, buffer, Date.now())) {
        const built = buildDigest(after, { items: buffer, at: Date.now() })
        const result = await deliver(ctx, after, built)
        if (result.ok) {
          await mutate((state) => ({
            ...state,
            digestBuffer: [],
            digest: { ...state.digest, lastAt: Date.now() },
          }))
          done.digest = true
        }
      }

      return { ok: true, ...done }
    } finally {
      ticking = false
    }
  }

  // --- completion watcher -------------------------------------------------
  // `agent/status` is the loop's own idle⇄running edge, so a running→idle
  // transition is exactly "the turn this session was working on finished".
  const wasRunning = new Map()
  ctx.effect(() => ctx.on('agent/status', (payload) => {
    const agent = payload?.agent
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const previous = wasRunning.get(sessionId) === true
    const running = payload?.status === 'running'
    wasRunning.set(sessionId, running)
    if (!previous || running) return
    void (async () => {
      await sleep(SETTLE_MS)
      const store = ctx.get('sessions')
      const session = store !== undefined && store !== null && typeof store.get === 'function'
        ? (store.get(sessionId) ?? agent.session)
        : agent.session
      try {
        await report(session, sessionId)
      } catch (error) {
        ctx.logger?.warn?.(`session-mail-notifier: 汇报失败 ${String(error)}`)
      }
    })()
  }), 'session-mail-notifier: agent/status watcher')

  // --- scheduler ----------------------------------------------------------
  ctx.effect(() => {
    const timer = setInterval(() => {
      void tick().catch((error) => {
        ctx.logger?.warn?.(`session-mail-notifier: 调度失败 ${String(error)}`)
      })
    }, TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'session-mail-notifier: scheduler')

  // --- routes -------------------------------------------------------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      const pathname = new URL(String(req.url), 'http://localhost').pathname
      const route = pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'

      try {
        if (route === '/state' && req.method === 'GET') {
          const current = await settings()
          const sessions = liveSessions()
          sendJson(res, 200, {
            ok: true,
            settings: { ...publicView(current, ctx), watches: describeWatches(current, sessions) },
            sessions,
          })
          return
        }

        if (route === '/sessions' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, sessions: liveSessions() })
          return
        }

        if (route === '/settings' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const saved = await mutate((current) => {
            const next = { ...current }
            const assignString = (field) => {
              if (typeof body[field] === 'string') next[field] = body[field].trim()
            }
            assignString('bindEmail')
            assignString('smtpHost')
            assignString('smtpUser')
            assignString('notifyTo')
            assignString('subjectPrefix')
            if (typeof body.smtpPass === 'string' && body.smtpPass.length > 0) next.smtpPass = body.smtpPass
            if (body.clearPass === true) next.smtpPass = ''
            if (Number.isInteger(body.smtpPort)) next.smtpPort = body.smtpPort
            if (typeof body.smtpSecure === 'boolean') next.smtpSecure = body.smtpSecure
            if (typeof body.enabled === 'boolean') next.enabled = body.enabled
            if (typeof body.includeSummary === 'boolean') next.includeSummary = body.includeSummary
            if (Number.isInteger(body.summaryChars)) next.summaryChars = body.summaryChars
            if (Array.isArray(body.watches)) next.watches = body.watches
            if (body.template === 'structured' || body.template === 'brief') next.template = body.template
            if (typeof body.includeMetrics === 'boolean') next.includeMetrics = body.includeMetrics
            if (typeof body.failureAlerts === 'boolean') next.failureAlerts = body.failureAlerts
            if (Number.isInteger(body.retryLimit)) next.retryLimit = body.retryLimit
            if (Number.isInteger(body.retryBaseMs)) next.retryBaseMs = body.retryBaseMs
            if (body.quiet !== null && typeof body.quiet === 'object') {
              next.quiet = {
                enabled: body.quiet.enabled === true,
                from: typeof body.quiet.from === 'string' ? body.quiet.from : next.quiet.from,
                to: typeof body.quiet.to === 'string' ? body.quiet.to : next.quiet.to,
              }
            }
            if (body.digest !== null && typeof body.digest === 'object') {
              next.digest = {
                enabled: body.digest.enabled === true,
                at: typeof body.digest.at === 'string' ? body.digest.at : next.digest.at,
                lastAt: next.digest.lastAt,
              }
            }
            return next
          })
          // Saving a complete account is the binding step: prove it by
          // delivering one real message before calling it verified.
          if (body.verify === true) {
            const probe = await deliver(ctx, saved, {
              to: saved.notifyTo.length > 0 ? saved.notifyTo : saved.bindEmail,
              subject: `${saved.subjectPrefix}：绑定验证`,
              text: '这是一封来自 DSH 插件 session-mail-notifier 的绑定验证邮件。\n收到它说明发件邮箱与 SMTP 授权码可用，之后指定会话每完成一轮任务都会向目标邮箱发送汇报。',
            })
            if (probe.ok) await mutate((latest) => ({ ...latest, verifiedAt: Date.now() }))
            sendJson(res, probe.ok ? 200 : 502, {
              ok: probe.ok,
              error: probe.ok ? undefined : probe.error,
              settings: publicView(await settings(), ctx),
            })
            return
          }
          sendJson(res, 200, { ok: true, settings: publicView(saved, ctx) })
          return
        }

        if (route === '/watch' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const id = typeof body.id === 'string' ? body.id.trim() : ''
          if (id.length === 0) {
            sendJson(res, 400, { ok: false, error: '缺少会话 ID' })
            return
          }
          const sessions = liveSessions()
          const known = sessions.find(session => session.id === id)
          const saved = await mutate((current) => {
            const rest = current.watches.filter(entry => entry.id !== id)
            if (body.watch === false) return { ...current, watches: rest }
            const requested = typeof body.title === 'string' ? body.title.trim() : ''
            const title = requested.length > 0 ? requested : (known?.title ?? '')
            return { ...current, watches: [...rest, { id, title, addedAt: Date.now() }] }
          })
          sendJson(res, 200, {
            ok: true,
            live: known !== undefined,
            settings: { ...publicView(saved, ctx), watches: describeWatches(saved, sessions) },
          })
          return
        }

        if (route === '/history' && req.method === 'POST') {
          const cleared = await mutate((current) => ({ ...current, history: [] }))
          sendJson(res, 200, { ok: true, settings: publicView(cleared, ctx) })
          return
        }

        if (route === '/queue' && req.method === 'POST') {
          const body = await readJsonBody(req)
          if (body.action === 'flush') {
            const result = await tick({ force: true })
            sendJson(res, 200, { ok: true, ...result, settings: publicView(await settings(), ctx) })
            return
          }
          if (body.action === 'clear') {
            const cleared = await mutate((current) => ({ ...current, outbox: [], deferred: [] }))
            sendJson(res, 200, { ok: true, settings: publicView(cleared, ctx) })
            return
          }
          sendJson(res, 400, { ok: false, error: '未知动作' })
          return
        }

        if (route === '/test' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const current = await settings()
          const result = await deliver(ctx, current, {
            to: typeof body.to === 'string' && body.to.trim().length > 0 ? body.to.trim() : undefined,
            subject: `${current.subjectPrefix}：测试邮件`,
            text: `这是一封测试邮件。\n发送时间：${stamp(Date.now())}\n绑定邮箱：${current.bindEmail || '(未填写)'}`,
          })
          if (result.ok) await mutate((latest) => ({ ...latest, verifiedAt: Date.now() }))
          sendJson(res, 200, { ok: result.ok, error: result.error, to: result.to })
          return
        }

        if (route === '/report' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const id = typeof body.id === 'string' ? body.id.trim() : ''
          const store = ctx.get('sessions')
          const session = store !== undefined && store !== null && typeof store.get === 'function'
            ? store.get(id)
            : undefined
          if (session === undefined || session === null) {
            sendJson(res, 404, { ok: false, error: '找不到该会话（只在活动会话中汇报）' })
            return
          }
          const result = await report(session, id, { force: true })
          sendJson(res, result.ok ? 200 : 502, { ok: result.ok, error: result.error })
          return
        }

        sendJson(res, 404, { ok: false, error: 'unknown route' })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `session-mail-notifier: ${ROUTE_PREFIX}/*`)

  ctx.logger?.info?.('session-mail-notifier: 已挂载，设置页位于 设置 → 完成邮件汇报')
}

/** Exported for the unit tests: the label a failure carries into a subject line. */
export { reasonLabel }
