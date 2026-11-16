/**
 * Unit tests for delivery scheduling.
 *
 * Every case uses an explicit local timestamp, so the suite never depends on
 * the machine clock or on the timezone the test happens to run in.
 */

import {
  OUTBOX_LIMIT,
  clockMinutes,
  digestDue,
  digestSlotAt,
  dueJobs,
  enqueue,
  exhausted,
  isQuiet,
  nextDigestAt,
  quietEndsAt,
  retryAt,
  sameDay,
} from '../queue.js'

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

const at = (hour, minute, day = 16) => new Date(2026, 10, day, hour, minute, 0, 0).getTime()

// --- clock parsing ---------------------------------------------------------
check('clock ok', clockMinutes('22:00'), 1320)
check('clock midnight', clockMinutes('00:00'), 0)
check('clock malformed', clockMinutes('24:00'), null)
check('clock junk', clockMinutes('8:00'), null)

// --- quiet hours -----------------------------------------------------------
const night = { enabled: true, from: '22:00', to: '08:00' }
const noon = { enabled: true, from: '12:00', to: '13:30' }
assert('quiet inside night window', isQuiet(night, at(23, 30)))
assert('quiet before midnight edge', isQuiet(night, at(22, 0)))
assert('quiet after midnight still inside', isQuiet(night, at(3, 0)))
assert('not quiet at the end edge', isQuiet(night, at(8, 0)) === false)
assert('not quiet midday', isQuiet(night, at(14, 0)) === false)
assert('quiet inside same-day window', isQuiet(noon, at(12, 15)))
assert('not quiet after same-day window', isQuiet(noon, at(13, 30)) === false)
assert('disabled window is never quiet', isQuiet({ ...night, enabled: false }, at(23, 0)) === false)
assert('invalid window is never quiet', isQuiet({ enabled: true, from: 'x', to: '08:00' }, at(23, 0)) === false)
assert('empty window is never quiet', isQuiet({ enabled: true, from: '22:00', to: '22:00' }, at(23, 0)) === false)

check('quiet ends next morning', quietEndsAt(night, at(23, 30)), at(8, 0, 17))
check('quiet ends same night', quietEndsAt(night, at(2, 0)), at(8, 0))
check('no end when not quiet', quietEndsAt(night, at(14, 0)), null)

// --- retry backoff ---------------------------------------------------------
check('first retry is base', retryAt(1, 60_000, 0), 60_000)
check('second retry triples', retryAt(2, 60_000, 0), 180_000)
check('third retry', retryAt(3, 60_000, 0), 540_000)
check('backoff is capped', retryAt(9, 60_000, 0), 3_600_000)
check('bad base falls back', retryAt(1, 10, 0), 60_000)

// --- queue -----------------------------------------------------------------
const job = { id: 'a', to: 'x@example.com', subject: 's', text: 't', createdAt: 0, nextAt: 0 }
const queued = enqueue([], job, 0)
check('enqueue length', queued.length, 1)
check('enqueue defaults', { attempts: queued[0].attempts, kind: queued[0].kind }, { attempts: 0, kind: 'report' })

const replaced = enqueue(queued, { ...job, subject: 'new' }, 10)
check('same id replaces', replaced.length, 1)
check('replacement kept the newer subject', replaced[0].subject, 'new')

const many = []
for (let index = 0; index < OUTBOX_LIMIT + 5; index += 1) {
  many.push({ id: `job-${index}`, to: 'x@example.com', subject: `s${index}`, text: 't', createdAt: index, nextAt: 0 })
}
let capped = []
for (const entry of many) capped = enqueue(capped, entry, 0)
check('queue is capped', capped.length, OUTBOX_LIMIT)
check('queue keeps the newest', capped[capped.length - 1].id, `job-${OUTBOX_LIMIT + 4}`)

const due = dueJobs([
  { id: 'late', nextAt: 2000 },
  { id: 'ready', nextAt: 500 },
  { id: 'early', nextAt: 1500 },
], 1500)
check('due jobs sorted', due.map(entry => entry.id), ['ready', 'early'])
check('no due jobs on empty queue', dueJobs(null, 10), [])

check('exhausted keeps over-limit', exhausted([{ attempts: 5 }, { attempts: 1 }], 4).length, 1)

// --- digest ----------------------------------------------------------------
const digest = { enabled: true, at: '09:00', lastAt: null }
check('next digest is today when before the hour', nextDigestAt(digest, at(8, 0)), at(9, 0))
check('next digest is tomorrow when after the hour', nextDigestAt(digest, at(10, 0)), at(9, 0, 17))
check('digest slot is today', digestSlotAt(digest, at(10, 0)), at(9, 0))
assert('digest due after the hour', digestDue(digest, [{ at: at(8, 30) }], at(9, 5)))
assert('digest not due before the hour', digestDue(digest, [{ at: at(8, 30) }], at(8, 55)) === false)
assert('digest not due twice', digestDue({ ...digest, lastAt: at(9, 1) }, [{ at: at(8, 30) }], at(9, 30)) === false)
assert('digest not due with an empty buffer', digestDue(digest, [], at(9, 5)) === false)
assert('disabled digest is never due', digestDue({ ...digest, enabled: false }, [{ at: at(8, 30) }], at(9, 5)) === false)

// --- day filtering ---------------------------------------------------------
const buffer = [{ at: at(8, 0) }, { at: at(23, 0) }, { at: at(8, 0, 15) }, { at: 'junk' }]
check('sameDay keeps only today', sameDay(buffer, at(12, 0)).length, 2)
check('sameDay tolerates junk', sameDay(null, at(12, 0)), [])

console.log(failures === 0 ? '\nPASS: queue.js' : `\nFAIL: ${failures} assertion(s)`)
if (failures > 0) process.exitCode = 1
