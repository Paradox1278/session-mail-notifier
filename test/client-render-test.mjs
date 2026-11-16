/**
 * Client-half harness: execute the browser factory with a minimal React mock,
 * exercise all four slot registrations, and walk the produced element trees.
 * Each component keeps its own hook cells, like React, so nested components
 * (SessionIdBox inside the page) do not corrupt their parent's state.
 */

import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// --- minimal React -------------------------------------------------------
const records = new Map() // componentFn -> { cells, effects }
const frames = []

function frameFor(component) {
  let record = records.get(component)
  if (record === undefined) {
    record = { cells: [], effects: [] }
    records.set(component, record)
  }
  return { record, index: 0 }
}

const frame = () => frames[frames.length - 1]

function slot(initial) {
  const current = frame()
  const index = current.index++
  const cells = current.record.cells
  if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
  return { cells, index }
}

function createElement(type, props, ...children) {
  const flat = children.length === 1 ? children[0] : children
  return { type, props: { ...(props ?? {}), children: flat } }
}

const ReactMock = {
  createElement,
  useState(initial) {
    const { cells, index } = slot(initial)
    return [cells[index], (value) => {
      cells[index] = typeof value === 'function' ? value(cells[index]) : value
    }]
  },
  useRef(initial) {
    const current = frame()
    const index = current.index++
    const cells = current.record.cells
    if (!(index in cells)) cells[index] = { current: initial }
    return cells[index]
  },
  useCallback(fn) {
    const current = frame()
    const index = current.index++
    const cells = current.record.cells
    if (!(index in cells)) cells[index] = fn
    return cells[index]
  },
  useEffect(fn) {
    const current = frame()
    const index = current.index++
    current.record.effects.push({ index, fn })
  },
}

// --- captured loader definition -----------------------------------------
let captured
const sandbox = {
  window: {
    __ModuleLoader__: { load: (definition) => { captured = definition } },
    addEventListener() {},
    removeEventListener() {},
  },
  fetch: async () => { throw new Error('fetch not stubbed') },
  console,
  URL,
}
sandbox.globalThis = sandbox
createContext(sandbox)
runInContext(source, sandbox)

console.log('factory id:', captured.id)

const plugin = captured.factory((name) => {
  if (name === 'react') return ReactMock
  throw new Error(`unexpected require: ${name}`)
})
console.log('inject:', plugin.inject)

const registrations = []
const ctx = {
  slots: {
    inject(owner, callback) {
      callback()
      console.log('slot owner:', owner)
    },
    register(options, component) {
      registrations.push({ options, component })
    },
  },
}

// The plugin refreshes itself inside apply(); the stub must exist by then, and
// it reads liveState lazily so the fixture can be declared further down.
const requests = []
sandbox.fetch = async (url, init) => {
  requests.push(`${init?.method ?? 'GET'} ${url}`)
  return { ok: true, status: 200, async text() { return JSON.stringify(liveState) } }
}

plugin.apply(ctx)

for (const entry of registrations) {
  const injected = entry.options.inject?.() ?? {}
  console.log(`registered ${entry.options.name} #${entry.options.id} order=${entry.options.order ?? '-'} inject=${Object.keys(injected).join(',')}`)
}

const bySlot = Object.fromEntries(registrations.map(entry => [entry.options.name, entry]))

// --- render helpers ------------------------------------------------------
function walk(node, sink) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    sink.texts.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, sink)
    return
  }
  if (typeof node.type === 'function') {
    frames.push(frameFor(node.type))
    try {
      walk(node.type(node.props ?? {}), sink)
    } finally {
      frames.pop()
    }
    return
  }
  sink.nodes.push(node)
  walk(node.props?.children, sink)
}

/** One render pass of one component, then drain every effect the pass queued. */
async function pass(component, props, label) {
  for (const record of records.values()) record.effects = []
  const sink = { nodes: [], texts: [] }
  frames.push(frameFor(component))
  try {
    walk(component(props), sink)
  } finally {
    frames.pop()
  }
  for (const record of records.values()) {
    for (const effect of record.effects) {
      const result = effect.fn?.()
      if (result && typeof result.then === 'function') await result
    }
  }
  await new Promise(resolve => setTimeout(resolve, 40))
  console.log(`${label}: ${sink.nodes.length} nodes, ${sink.texts.length} texts`)
  return sink
}

// --- live-looking Host state --------------------------------------------
const liveState = {
  ok: true,
  settings: {
    enabled: true,
    bindEmail: 'sender@example.com',
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: 'sender@example.com',
    hasPass: true,
    notifyTo: 'target@example.com',
    subjectPrefix: '[DSH] 任务完成',
    includeSummary: true,
    summaryChars: 1200,
    watches: [
      { id: 'session-abc', title: '季度报告整理', addedAt: Date.now(), live: true },
      { id: 'session-xyz', title: '', addedAt: Date.now(), live: false },
    ],
    verifiedAt: Date.now(),
    lastSent: {},
    history: [
      { at: Date.now(), sessionId: 'session-abc', title: '季度报告整理', to: 'target@example.com', ok: true },
      { at: Date.now() - 60_000, sessionId: 'session-xyz', title: '', to: 'target@example.com', ok: false, error: 'ECONNREFUSED' },
    ],
    storage: 'credentials',
  },
  sessions: [
    { id: 'session-abc', title: '季度报告整理', cwd: 'F:\\work', updatedAt: Date.now() },
    { id: 'session-xyz', title: '', cwd: '', updatedAt: null },
  ],
}

// The plugin refreshed itself during apply(); give that fetch a turn now that
// the fixture above exists.
await new Promise(resolve => setTimeout(resolve, 40))

// --- 1. sidebar entrance (panellist) ------------------------------------
const panellist = await pass(bySlot['sidebar.panellist'].component, { size: 20, active: false }, 'sidebar.panellist')
const panellistGlyph = panellist.nodes.find(node => ['svg', 'button', 'span', 'div'].includes(node.type))

// --- 2. session row action ----------------------------------------------
const rowAction = await pass(bySlot['sidebar.workspaces.session.row.action'].component,
  { sessionId: 'session-abc', displayTitle: '季度报告整理' }, 'session.row.action')
const rowButton = rowAction.nodes.find(node => node.type === 'button')
console.log('  aria-pressed:', rowButton?.props?.['aria-pressed'], '| title:', rowButton?.props?.title)

// --- 3. full page (main) ------------------------------------------------
await pass(bySlot['main'].component, bySlot['main'].options.inject(), 'main #1 (seeding draft)')
const page = await pass(bySlot['main'].component, bySlot['main'].options.inject(), 'main #2 (populated)')
const pageInputs = page.nodes.filter(node => node.type === 'input')
const sessionIdInput = pageInputs.find(node => String(node.props?.placeholder ?? '').includes('会话 ID'))
const cards = page.nodes.filter(node => String(node.props?.className ?? '').includes('smn-card'))
const rows = page.nodes.filter(node => node.type === 'tr')

console.log('  data-mode:', page.nodes[0]?.props?.['data-mode'])
console.log('  inputs:', pageInputs.length, '| cards:', cards.length, '| rows:', rows.length)
console.log('  session-id placeholder:', sessionIdInput?.props?.placeholder)
console.log('  titles:', page.texts.filter(text => ['监控一个会话', '发件邮箱', '最近的汇报'].includes(text)).join(' / '))

// --- 4. settings section (panel mode) -----------------------------------
await pass(bySlot['settings.section'].component, bySlot['settings.section'].options.inject(), 'settings.section #1 (seeding draft)')
const panel = await pass(bySlot['settings.section'].component, bySlot['settings.section'].options.inject(), 'settings.section #2 (populated)')
const panelInputs = panel.nodes.filter(node => node.type === 'input')
console.log('  data-mode:', panel.nodes[0]?.props?.['data-mode'], '| inputs:', panelInputs.length)

console.log('\nrequests:', requests.slice(0, 5))

const ok = registrations.length === 4
  && panellistGlyph !== undefined
  && rowButton?.props?.['aria-pressed'] === 'true'
  && page.nodes[0]?.props?.['data-mode'] === 'page'
  && sessionIdInput !== undefined
  && cards.length >= 4
  && rows.length >= 3
  && pageInputs.length >= 9
  && panel.nodes[0]?.props?.['data-mode'] === 'panel'
  && panelInputs.length >= 9

console.log('\nPASS:', ok)
