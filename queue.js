/**
 * Delivery scheduling: retry backoff, quiet hours, and the daily digest clock.
 *
 * The host half owns the timer and the storage; everything here is a pure
 * decision function over plain values, so each rule can be tested with a fixed
 * clock instead of a live event loop.
 */

/** Deepest backoff between two attempts; an hour is long enough to be polite. */
const MAX_BACKOFF_MS = 3_600_000

/** How many queued messages may wait for retry at once. */
export const OUTBOX_LIMIT = 20

/** Longest body kept in the durable queue, in characters. */
const BODY_LIMIT = 12_000

/** Parse `HH:MM` into minutes past local midnight, or null when malformed. */
export function clockMinutes(value) {
  if (typeof value !== 'string') return null
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value)
  if (match === null) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** Minutes past local midnight for one instant. */
function minutesOf(at) {
  const date = new Date(at)
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * Whether `at` falls inside the configured quiet window.
 *
 * A window is half-open — `22:00` is quiet, `08:00` is not — and may wrap past
 * midnight. An empty or invalid window is never quiet, so a bad preference can
 * not silently swallow a report.
 */
export function isQuiet(quiet, at) {
  if (quiet === null || typeof quiet !== 'object' || quiet.enabled !== true) return false
  const from = clockMinutes(quiet.from)
  const to = clockMinutes(quiet.to)
  if (from === null || to === null || from === to) return false
  const now = minutesOf(at)
  if (from < to) return now >= from && now < to
  return now >= from || now < to
}

/**
 * When the current quiet window ends, or null when `at` is not quiet.
 *
 * The result is always in the future relative to `at`; the caller uses it to
 * decide whether a timer must be armed.
 */
export function quietEndsAt(quiet, at) {
  if (!isQuiet(quiet, at)) return null
  const to = clockMinutes(quiet.to)
  if (to === null) return null
  const date = new Date(at)
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(to / 60), to % 60, 0, 0)
  if (end.getTime() <= at) end.setDate(end.getDate() + 1)
  return end.getTime()
}

/**
 * The instant a queued message becomes due again.
 *
 * Backoff is exponential off the configured base: 1×, 3×, 9×, 27×… capped at an
 * hour, so a broken SMTP password settles into one attempt per hour instead of a
 * hot loop that a provider would read as abuse.
 */
export function retryAt(attempts, baseMs, now) {
  const base = Number.isFinite(baseMs) && baseMs >= 5_000 ? baseMs : 60_000
  const exponent = Math.max(0, Math.min(attempts - 1, 6))
  const delay = Math.min(base * 3 ** exponent, MAX_BACKOFF_MS)
  return now + delay
}

/** Append one job, replacing any earlier job with the same id, capped by limit. */
export function enqueue(outbox, job, now) {
  const list = Array.isArray(outbox) ? outbox.filter(entry => entry && entry.id !== job.id) : []
  const entry = {
    id: job.id,
    kind: job.kind ?? 'report',
    to: job.to,
    subject: String(job.subject ?? '').slice(0, 400),
    text: String(job.text ?? '').slice(0, BODY_LIMIT),
    attempts: Number.isInteger(job.attempts) ? job.attempts : 0,
    createdAt: Number.isFinite(job.createdAt) ? job.createdAt : now,
    nextAt: Number.isFinite(job.nextAt) ? job.nextAt : now,
    sessionId: typeof job.sessionId === 'string' ? job.sessionId : undefined,
    title: typeof job.title === 'string' ? job.title : undefined,
    turn: Number.isInteger(job.turn) ? job.turn : undefined,
    reason: typeof job.reason === 'string' ? job.reason : undefined,
    durationMs: typeof job.durationMs === 'number' ? job.durationMs : undefined,
    lastError: typeof job.lastError === 'string' ? job.lastError.slice(0, 400) : undefined,
  }
  const next = [...list, entry]
  return next.length > OUTBOX_LIMIT ? next.slice(next.length - OUTBOX_LIMIT) : next
}

/** Queued jobs whose backoff has elapsed, oldest first. */
export function dueJobs(outbox, now) {
  if (!Array.isArray(outbox)) return []
  return outbox
    .filter(entry => entry && typeof entry.nextAt === 'number' && entry.nextAt <= now)
    .sort((a, b) => a.nextAt - b.nextAt)
}

/**
 * The next instant the digest should fire after `now`.
 *
 * A digest belongs to a calendar day: once today's clock time has passed, the
 * next opportunity is tomorrow, which keeps the mail at a predictable hour even
 * after the app was closed for a day.
 */
export function nextDigestAt(digest, now) {
  const minutes = clockMinutes(digest?.at)
  if (minutes === null) return null
  const date = new Date(now)
  const candidate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    0,
  )
  if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

/** Today's digest clock time, used to tell whether `lastAt` already covered it. */
export function digestSlotAt(digest, now) {
  const minutes = clockMinutes(digest?.at)
  if (minutes === null) return null
  const date = new Date(now)
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    0,
  ).getTime()
}

/**
 * Whether the daily digest is due.
 *
 * Disabled digests are never due, an empty buffer has nothing to say, and a
 * `lastAt` from the current slot blocks a second send on the same day.
 */
export function digestDue(digest, buffer, now) {
  if (digest === null || typeof digest !== 'object' || digest.enabled !== true) return false
  if (!Array.isArray(buffer) || buffer.length === 0) return false
  const slot = digestSlotAt(digest, now)
  if (slot === null || now < slot) return false
  const lastAt = typeof digest.lastAt === 'number' ? digest.lastAt : null
  return lastAt === null || lastAt < slot
}

/** Keep only the buffer entries from the same local day as `at`. */
export function sameDay(buffer, at) {
  if (!Array.isArray(buffer)) return []
  const date = new Date(at)
  return buffer.filter((entry) => {
    if (entry === null || typeof entry !== 'object' || typeof entry.at !== 'number') return false
    const item = new Date(entry.at)
    return item.getFullYear() === date.getFullYear()
      && item.getMonth() === date.getMonth()
      && item.getDate() === date.getDate()
  })
}

/** Drop expired retry jobs whose attempt budget is spent. */
export function exhausted(outbox, retryLimit) {
  if (!Array.isArray(outbox)) return []
  const limit = Number.isInteger(retryLimit) && retryLimit >= 0 ? retryLimit : 4
  return outbox.filter(entry => entry && Number.isInteger(entry.attempts) && entry.attempts > limit)
}
