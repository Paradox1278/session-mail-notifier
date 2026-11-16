/**
 * Durable settings for the session mail notifier.
 *
 * Secrets (the SMTP authorization code) must never live in configuration, so
 * the whole settings document is one credential record owned by this plugin.
 * When a composition has no credential store, the same document is written to
 * a private JSON file under DSH_HOME instead.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Record key: `<plugin scope>/<id>`. */
export const RECORD_KEY = 'session-mail-notifier/settings'

/** Owner-visible defaults; every field is replaced by what the page saves. */
export function defaults() {
  return {
    enabled: true,
    bindEmail: '',
    smtpHost: '',
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: '',
    smtpPass: '',
    notifyTo: '',
    subjectPrefix: '[DSH] 任务完成',
    template: 'structured',
    includeSummary: true,
    summaryChars: 1200,
    includeMetrics: true,
    failureAlerts: true,
    retryLimit: 4,
    retryBaseMs: 60_000,
    quiet: { enabled: false, from: '22:00', to: '08:00' },
    digest: { enabled: false, at: '09:00', lastAt: null },
    watches: [],
    verifiedAt: null,
    lastSent: {},
    outbox: [],
    deferred: [],
    digestBuffer: [],
    history: [],
  }
}

const isClock = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(value)

/** Coerce everything keyed by session id into a plain record. */
function recordOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Coerce whatever was stored into the documented shape. */
export function normalize(raw) {
  const base = defaults()
  if (raw === null || typeof raw !== 'object') return base
  const value = raw
  const quiet = recordOf(value.quiet)
  const digest = recordOf(value.digest)
  return {
    enabled: value.enabled !== false,
    bindEmail: typeof value.bindEmail === 'string' ? value.bindEmail : base.bindEmail,
    smtpHost: typeof value.smtpHost === 'string' ? value.smtpHost : base.smtpHost,
    smtpPort: Number.isInteger(value.smtpPort) && value.smtpPort > 0 && value.smtpPort < 65_536
      ? value.smtpPort
      : base.smtpPort,
    smtpSecure: value.smtpSecure !== false,
    smtpUser: typeof value.smtpUser === 'string' ? value.smtpUser : base.smtpUser,
    smtpPass: typeof value.smtpPass === 'string' ? value.smtpPass : base.smtpPass,
    notifyTo: typeof value.notifyTo === 'string' ? value.notifyTo : base.notifyTo,
    subjectPrefix: typeof value.subjectPrefix === 'string' && value.subjectPrefix.trim().length > 0
      ? value.subjectPrefix
      : base.subjectPrefix,
    template: value.template === 'brief' ? 'brief' : 'structured',
    includeSummary: value.includeSummary !== false,
    summaryChars: Number.isInteger(value.summaryChars) && value.summaryChars >= 200
      ? Math.min(value.summaryChars, 20_000)
      : base.summaryChars,
    includeMetrics: value.includeMetrics !== false,
    failureAlerts: value.failureAlerts !== false,
    retryLimit: Number.isInteger(value.retryLimit) && value.retryLimit >= 0
      ? Math.min(value.retryLimit, 10)
      : base.retryLimit,
    retryBaseMs: Number.isInteger(value.retryBaseMs) && value.retryBaseMs >= 5_000
      ? Math.min(value.retryBaseMs, 3_600_000)
      : base.retryBaseMs,
    quiet: {
      enabled: quiet.enabled === true,
      from: isClock(quiet.from) ? quiet.from : base.quiet.from,
      to: isClock(quiet.to) ? quiet.to : base.quiet.to,
    },
    digest: {
      enabled: digest.enabled === true,
      at: isClock(digest.at) ? digest.at : base.digest.at,
      lastAt: typeof digest.lastAt === 'number' ? digest.lastAt : null,
    },
    watches: Array.isArray(value.watches)
      ? value.watches
        .filter(entry => entry && typeof entry.id === 'string' && entry.id.length > 0)
        .map(entry => ({
          id: entry.id,
          title: typeof entry.title === 'string' ? entry.title : '',
          addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : Date.now(),
        }))
      : [],
    verifiedAt: typeof value.verifiedAt === 'number' ? value.verifiedAt : null,
    lastSent: Object.fromEntries(
      Object.entries(recordOf(value.lastSent)).filter(([, entry]) => entry && typeof entry === 'object'),
    ),
    outbox: Array.isArray(value.outbox)
      ? value.outbox.filter(entry => entry && typeof entry === 'object' && typeof entry.id === 'string').slice(-20)
      : [],
    deferred: Array.isArray(value.deferred)
      ? value.deferred.filter(entry => entry && typeof entry === 'object').slice(-50)
      : [],
    digestBuffer: Array.isArray(value.digestBuffer)
      ? value.digestBuffer.filter(entry => entry && typeof entry === 'object').slice(-200)
      : [],
    history: Array.isArray(value.history)
      ? value.history.filter(entry => entry && typeof entry === 'object').slice(-50)
      : [],
  }
}

/** The file-backed fallback location, outside the profile so installs never rewrite it. */
export function fallbackPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'session-mail-notifier.json')
}

async function readFileSettings(path) {
  try {
    const text = await readFile(path, 'utf8')
    return normalize(JSON.parse(text))
  } catch {
    // Missing or unreadable state is simply the documented default.
    return defaults()
  }
}

async function writeFileSettings(path, settings) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/**
 * Read the settings document.
 *
 * @returns settings plus the storage backend actually used.
 */
export async function loadSettings(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && credentials !== null) {
    try {
      const record = await credentials.readRecord(RECORD_KEY)
      if (record !== undefined && record !== null && record.kind === 'grant' && record.payload !== undefined) {
        return { settings: normalize(record.payload), storage: 'credentials' }
      }
      return { settings: defaults(), storage: 'credentials' }
    } catch {
      // A provider failure falls through to the file backend rather than
      // losing the page: the user still sees a working, if separate, store.
    }
  }
  return { settings: await readFileSettings(fallbackPath()), storage: 'file' }
}

/**
 * A credentials record must be plain JSON data. `undefined`, functions and
 * symbols are not representable; a round trip drops them instead of letting the
 * provider reject the whole record.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * Persist the complete settings document through the exclusive write path.
 *
 * @returns the backend that accepted the write.
 */export async function saveSettings(ctx, settings) {
  const next = plain(normalize(settings))
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && credentials !== null) {
    await credentials.modifyRecord(RECORD_KEY, async () => ({ kind: 'grant', payload: next }))
    return 'credentials'
  }
  await writeFileSettings(fallbackPath(), next)
  return 'file'
}

/** Report which backend a save would use, without writing. */
export function storageBackend(ctx) {
  const credentials = ctx.get('credentials')
  return credentials === undefined || credentials === null ? 'file' : 'credentials'
}
