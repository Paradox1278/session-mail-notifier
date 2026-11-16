/**
 * Browser half of the session mail notifier.
 *
 * Surfaces:
 *   sidebar.panellist                    — the sidebar entrance beside Plugins / Market
 *   main (key = session-mail-notifier)   — the full page it opens
 *   settings.section                     — the same content inside Settings
 *   sidebar.workspaces.session.row.action — one-click watch on a Session row
 *
 * The page borrows the shell's own typography and tokens: inherited font,
 * layers for surfaces, one column of cards, state as a dot instead of badges.
 */

window.__ModuleLoader__.load({
  id: '@local/session-mail-notifier',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const ROUTE = 'session-mail-notifier'

    // --- provider presets --------------------------------------------------
    const PRESETS = [
      { id: 'netease', label: '163 邮箱', host: 'smtp.163.com', port: '465', secure: true },
      { id: '126', label: '126 邮箱', host: 'smtp.126.com', port: '465', secure: true },
      { id: 'qq', label: 'QQ 邮箱', host: 'smtp.qq.com', port: '465', secure: true },
      { id: 'gmail', label: 'Gmail', host: 'smtp.gmail.com', port: '465', secure: true },
      { id: 'outlook', label: 'Outlook / 365', host: 'smtp.office365.com', port: '587', secure: false },
      { id: 'custom', label: '自定义' },
    ]

    const AUTH_TIPS = {
      netease: '163：网页登录 → 设置 → POP3/SMTP/IMAP → 先开启「SMTP 服务」→ 再「新增授权密码」，得到 16 位授权码。填登录密码会返回 535。',
      126: '126：设置 → POP3/SMTP/IMAP → 开启 SMTP 服务 → 新增授权密码，16 位授权码。',
      qq: 'QQ：mail.qq.com → 设置 → 账户 → POP3/IMAP/SMTP 服务 → 开启并生成授权码（16 位，可能需短信验证）。',
      gmail: 'Gmail：开启两步验证 → 应用专用密码，16 位；账号密码会被拒绝。',
      outlook: 'Outlook：需应用密码，且租户允许 SMTP AUTH；用 587 + STARTTLS。',
      custom: '填服务商提供的 SMTP 地址与「授权码 / 客户端专用密码」，不是网页登录密码。',
    }

    function providerOf(host) {
      const value = String(host ?? '').toLowerCase()
      if (value.includes('163.com')) return 'netease'
      if (value.includes('126.com') || value.includes('yeah.net')) return '126'
      if (value.includes('qq.com') || value.includes('foxmail')) return 'qq'
      if (value.includes('gmail') || value.includes('googlemail')) return 'gmail'
      if (value.includes('office365') || value.includes('outlook') || value.includes('hotmail')) return 'outlook'
      return 'custom'
    }

    const CSS = `
.smn-root{--smn-line:var(--dsw-alias-border-l1);--smn-line-strong:var(--dsw-alias-border-l2);--smn-ink:var(--dsw-alias-label-primary);--smn-mute:var(--dsw-alias-label-secondary);--smn-fill:var(--dsw-alias-bg-layer-1);--smn-accent:var(--dsw-alias-brand-primary);font:inherit;color:var(--smn-ink);box-sizing:border-box}
.smn-root *{box-sizing:border-box}
.smn-root[data-mode="page"]{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden}
.smn-root[data-mode="panel"]{display:block;width:100%}
.smn-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex:none;padding:18px 20px 14px}
.smn-root[data-mode="panel"] .smn-head{padding:2px 2px 14px}
.smn-title{font-size:1.25em;font-weight:600;margin:0;letter-spacing:normal}
.smn-sub{margin:5px 0 0;font-size:.84em;line-height:1.55;color:var(--smn-mute);max-width:62ch}
.smn-status{display:flex;align-items:center;gap:14px;flex:none;font-size:.82em;color:var(--smn-mute);white-space:nowrap}
.smn-state{display:inline-flex;align-items:center;gap:6px}
.smn-dot{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);flex:none}
.smn-dot.is-ok{background:var(--dsw-alias-state-success-primary)}
.smn-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}
.smn-body{min-height:0;flex:1;overflow:auto;padding:0 20px 28px;scrollbar-gutter:stable;overscroll-behavior:contain}
.smn-root[data-mode="panel"] .smn-body{overflow:visible;padding:0}
.smn-stack{display:flex;flex-direction:column;gap:14px;max-width:860px}
.smn-root[data-mode="panel"] .smn-stack{max-width:none}
.smn-card{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--smn-line);border-radius:10px;background:var(--smn-fill);min-width:0}
.smn-card-primary{border-color:color-mix(in srgb,var(--smn-accent) 45%,transparent)}
.smn-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.smn-card-titles{display:flex;flex-direction:column;gap:3px;min-width:0}
.smn-card-title{font-size:.95em;font-weight:600}
.smn-card-hint{font-size:.8em;line-height:1.55;color:var(--smn-mute)}
.smn-lead{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.smn-input,.smn-select{height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--smn-line-strong);background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:.9em;outline:none;min-width:0}
.smn-input::placeholder{color:var(--smn-mute)}
.smn-input:focus,.smn-select:focus{border-color:var(--smn-accent)}
.smn-input-lg{height:36px;flex:1 1 280px;font-size:.94em}
.smn-time{width:112px;flex:none}
.smn-btn{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--smn-line-strong);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:.88em;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
.smn-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-secondary)}
.smn-btn:disabled{opacity:.45;cursor:default}
.smn-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;font-weight:500}
.smn-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);filter:brightness(1.1)}
.smn-btn-lg{height:36px;padding:0 16px;font-size:.9em}
.smn-btn-quiet{border-color:transparent;background:transparent;color:var(--smn-mute);padding:0 8px}
.smn-btn-quiet:hover:not(:disabled){color:var(--smn-ink);background:var(--dsw-alias-bg-layer-2);border-color:transparent}
.smn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 14px}
.smn-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.smn-label{font-size:.8em;color:var(--smn-mute)}
.smn-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.smn-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.smn-note{font-size:.8em;line-height:1.6;color:var(--smn-mute);word-break:break-word}
.smn-ok{color:var(--dsw-alias-state-success-primary)}
.smn-err{color:var(--dsw-alias-state-error-primary)}
.smn-warn{color:var(--dsw-alias-state-warn-primary)}
.smn-check{display:inline-flex;align-items:center;gap:7px;font-size:.82em;color:var(--smn-mute);cursor:pointer}
.smn-check input[type="checkbox"]{accent-color:var(--dsw-alias-brand-primary);width:14px;height:14px;margin:0;cursor:pointer}
.smn-list{display:flex;flex-direction:column}
.smn-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--smn-line);min-width:0}
.smn-item:first-child{border-top:0}
.smn-item-main{display:flex;flex-direction:column;gap:3px;min-width:0}
.smn-item-title{font-size:.9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46ch}
.smn-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.74em;color:var(--smn-mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46ch}
.smn-table{width:100%;border-collapse:collapse;font-size:.82em}
.smn-table th,.smn-table td{text-align:left;padding:7px 8px 7px 0;border-top:1px solid var(--smn-line);vertical-align:top}
.smn-table th{border-top:0;font-weight:500;color:var(--smn-mute);font-size:.94em}
.smn-table td.smn-ok,.smn-table td.smn-err{white-space:nowrap}
.smn-empty{font-size:.82em;color:var(--smn-mute);padding:6px 0}
.smn-chips{display:flex;gap:6px;flex-wrap:wrap}
.smn-chip{max-width:230px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--smn-line-strong);background:transparent;color:var(--smn-mute);font:inherit;font-size:.8em;cursor:pointer;display:inline-flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.smn-chip:hover{border-color:var(--smn-accent);color:var(--smn-ink)}
.smn-chip-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.smn-row-btn{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;border:1px solid transparent;background:transparent;color:var(--smn-mute);cursor:pointer;padding:0}
.smn-row-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--smn-ink)}
.smn-row-btn-on{color:var(--dsw-alias-state-success-primary)}
`

    // --- shared store ------------------------------------------------------
    function createStore() {
      let snapshot = {
        loaded: false,
        loading: false,
        error: null,
        settings: null,
        sessions: [],
      }
      const listeners = new Set()
      return {
        get() {
          return snapshot
        },
        set(patch) {
          snapshot = { ...snapshot, ...patch }
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const store = createStore()

    async function call(path, payload) {
      const init = { credentials: 'same-origin' }
      if (payload !== undefined) {
        init.method = 'POST'
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(payload)
      }
      let response
      try {
        response = await fetch(`${ROUTE}${path}`, init)
      } catch (error) {
        return { ok: false, error: `无法访问插件后端：${String(error && error.message ? error.message : error)}` }
      }
      const text = await response.text()
      let body = {}
      if (text.length > 0) {
        try {
          body = JSON.parse(text)
        } catch {
          body = { ok: false, error: text.slice(0, 200) }
        }
      }
      if (body.ok === undefined) body.ok = response.ok
      return body
    }

    const actions = {
      async refresh() {
        store.set({ loading: true })
        const body = await call('/state')
        if (body.ok && body.settings) {
          store.set({ loaded: true, loading: false, error: null, settings: body.settings, sessions: body.sessions ?? [] })
        } else {
          store.set({ loaded: true, loading: false, error: body.error ?? '读取插件状态失败' })
        }
        return body
      },
      async saveSettings(patch, verify) {
        const body = await call('/settings', { ...patch, verify: verify === true })
        if (body.settings) store.set({ settings: body.settings })
        await actions.refresh()
        return body
      },
      async setWatch(id, title, watch) {
        const body = await call('/watch', { id, title, watch })
        if (body.ok && body.settings) store.set({ settings: body.settings })
        await actions.refresh()
        return body
      },
      async reportNow(id) {
        const body = await call('/report', { id })
        await actions.refresh()
        return body
      },
      async sendTest() {
        return call('/test', {})
      },
      async clearHistory() {
        const body = await call('/history', { clear: true })
        if (body.settings) store.set({ settings: body.settings })
        await actions.refresh()
        return body
      },
      async flushQueue() {
        const body = await call('/queue', { action: 'flush' })
        await actions.refresh()
        return body
      },
      async clearQueue() {
        const body = await call('/queue', { action: 'clear' })
        await actions.refresh()
        return body
      },
    }

    function useSnapshot() {
      const [snapshot, setSnapshot] = useState(store.get())
      useEffect(() => store.subscribe(() => setSnapshot(store.get())), [])
      return snapshot
    }

    const Envelope = (props) => h('svg', {
      width: props.size ?? 16,
      height: props.size ?? 16,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      'aria-hidden': true,
      style: { display: 'block', flex: 'none' },
    },
    h('rect', { x: 3, y: 5.5, width: 18, height: 13, rx: 2.5 }),
    h('path', { d: 'M4.4 7.4 12 12.5l7.6-5.1', strokeLinecap: 'round', strokeLinejoin: 'round' }))

    /** Sidebar icon; the shell owns the button, the selection colour and the label. */
    function PanelIcon(props) {
      return h(Envelope, { size: props.size ?? 18 })
    }

    function stamp(at) {
      if (typeof at !== 'number') return '—'
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function Message(props) {
      if (!props.notice) return null
      const tone = props.notice.kind === 'ok' ? 'smn-ok' : props.notice.kind === 'err' ? 'smn-err' : 'smn-warn'
      return h('p', {
        className: `smn-note ${tone}`,
        role: props.notice.kind === 'err' ? 'alert' : 'status',
        style: { whiteSpace: 'pre-line' },
      }, props.notice.text)
    }

    function Card(props) {
      return h('section', { className: `smn-card${props.primary ? ' smn-card-primary' : ''}` }, props.children)
    }

    function CardHead(props) {
      return h('div', { className: 'smn-card-head' },
        h('div', { className: 'smn-card-titles' },
          h('span', { className: 'smn-card-title' }, props.title),
          props.hint ? h('span', { className: 'smn-card-hint' }, props.hint) : null),
        props.actions ?? null)
    }

    function Labeled(props) {
      return h('label', { className: 'smn-field' },
        h('span', { className: 'smn-label' }, props.label),
        props.children)
    }

    /** A checkbox with the shell's own hit area and no surrounding chrome. */
    function Toggle(props) {
      return h('label', { className: 'smn-check', title: props.hint ?? undefined },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        props.label)
    }

    // --- primary control ---------------------------------------------------
    function WatchForm(props) {
      const [value, setValue] = useState('')
      const [busy, setBusy] = useState(false)
      const [hint, setHint] = useState(null)

      const submit = async () => {
        const id = value.trim()
        if (id.length === 0 || busy) return
        setBusy(true)
        setHint(null)
        const body = await actions.setWatch(id, '', true)
        setBusy(false)
        if (body.ok) {
          setValue('')
          setHint({
            kind: 'ok',
            text: body.live === false
              ? '已加入监控。该会话当前不在活动列表，它下次运行结束时才会汇报。'
              : '已开始监控，这个会话每完成一轮任务就会发邮件。',
          })
        } else {
          setHint({ kind: 'err', text: body.error ?? '添加失败' })
        }
      }

      return h('div', { className: 'smn-field', style: { gap: '8px' } },
        h('div', { className: 'smn-row' },
          h('input', {
            className: 'smn-input smn-input-lg',
            value,
            placeholder: '粘贴会话 ID，例如 session-19dad68e-…',
            'aria-label': '要监控的会话 ID',
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'smn-btn smn-btn-primary smn-btn-lg',
            disabled: busy || value.trim().length === 0,
            onClick: () => void submit(),
          }, busy ? '添加中…' : '开始监控')),
        h(Message, { notice: hint }),
        props.hint ? h('p', { className: 'smn-note' }, props.hint) : null)
    }

    // --- mailbox form ------------------------------------------------------
    function MailboxForm(props) {
      const { draft, setDraft, settings, busy, onSave, onTest, includeToggle } = props
      const set = (field) => (event) => {
        const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value
        setDraft((current) => ({ ...current, [field]: value }))
      }

      const provider = providerOf(draft.smtpHost)
      const applyPreset = (event) => {
        const preset = PRESETS.find(entry => entry.id === event.target.value)
        if (preset === undefined || preset.id === 'custom') return
        setDraft((current) => ({ ...current, smtpHost: preset.host, smtpPort: preset.port, smtpSecure: preset.secure }))
      }

      return h('div', { className: 'smn-field', style: { gap: '12px' } },
        h('div', { className: 'smn-grid' },
          h(Labeled, { label: '邮箱服务商（自动填服务器与端口）' },
            h('select', { className: 'smn-select', value: provider, onChange: applyPreset },
              PRESETS.map(preset => h('option', { key: preset.id, value: preset.id }, preset.label)))),
          h('div', { className: 'smn-field' },
            h('span', { className: 'smn-label' }, '授权码怎么拿'),
            h('span', { className: 'smn-note' }, AUTH_TIPS[provider] ?? AUTH_TIPS.custom))),
        h('div', { className: 'smn-grid' },
          h(Labeled, { label: '绑定邮箱（发件人）' },
            h('input', { className: 'smn-input', value: draft.bindEmail, onChange: set('bindEmail'), placeholder: 'you@example.com', autoComplete: 'off', spellCheck: false })),
          h(Labeled, { label: 'SMTP 服务器' },
            h('input', { className: 'smn-input', value: draft.smtpHost, onChange: set('smtpHost'), placeholder: 'smtp.qq.com', autoComplete: 'off', spellCheck: false })),
          h(Labeled, { label: '端口' },
            h('input', { className: 'smn-input', value: draft.smtpPort, onChange: set('smtpPort'), inputMode: 'numeric', placeholder: '465' })),
          h(Labeled, { label: '连接加密' },
            h('select', {
              className: 'smn-select',
              value: draft.smtpSecure ? 'tls' : 'starttls',
              onChange: (event) => setDraft((current) => ({ ...current, smtpSecure: event.target.value === 'tls' })),
            },
            h('option', { value: 'tls' }, 'SSL/TLS（465）'),
            h('option', { value: 'starttls' }, 'STARTTLS（587 / 25）'))),
          h(Labeled, { label: 'SMTP 用户名（留空用绑定邮箱）' },
            h(React.Fragment, null,
              h('input', { className: 'smn-input', value: draft.smtpUser, onChange: set('smtpUser'), placeholder: '留空即用绑定邮箱', autoComplete: 'off', spellCheck: false }),
              String(draft.smtpUser ?? '').trim() !== '' && !String(draft.smtpUser).includes('@')
                ? h('span', { className: 'smn-note smn-warn' }, '要填完整邮箱地址（如 you@163.com），否则认证一定返回 535')
                : null)),
          h(Labeled, { label: settings.hasPass ? 'SMTP 授权码（已保存，留空不改）' : 'SMTP 授权码' },
            h('input', {
              className: 'smn-input',
              type: 'password',
              value: draft.smtpPass,
              onChange: set('smtpPass'),
              placeholder: settings.hasPass ? '••••••••' : 'QQ/163 为授权码，不是登录密码',
              autoComplete: 'new-password',
            })),
          h(Labeled, { label: '汇报目标邮箱' },
            h('input', { className: 'smn-input', value: draft.notifyTo, onChange: set('notifyTo'), placeholder: 'report@example.com', autoComplete: 'off', spellCheck: false })),
          h(Labeled, { label: '邮件主题前缀' },
            h('input', { className: 'smn-input', value: draft.subjectPrefix, onChange: set('subjectPrefix'), placeholder: '[DSH] 任务完成' }))),
        h('div', { className: 'smn-row' },
          includeToggle
            ? h(Toggle, {
              label: '启用自动汇报',
              checked: draft.enabled,
              onChange: (value) => setDraft((current) => ({ ...current, enabled: value })),
            })
            : null),
        h('div', { className: 'smn-actions' },
          h('button', { type: 'button', className: 'smn-btn smn-btn-primary', disabled: busy !== '', onClick: () => void onSave(true) },
            busy === 'verify' ? '保存并验证中…' : '保存并验证'),
          h('button', { type: 'button', className: 'smn-btn', disabled: busy !== '', onClick: () => void onSave(false) },
            busy === 'save' ? '保存中…' : '仅保存'),
          h('button', { type: 'button', className: 'smn-btn', disabled: busy !== '', onClick: () => void onTest() },
            busy === 'test' ? '发送中…' : '发送测试邮件')),
        h('p', { className: 'smn-note' },
          'QQ smtp.qq.com:465　·　163 smtp.163.com:465　·　Gmail smtp.gmail.com:465（应用专用密码）　·　Outlook smtp.office365.com:587 + STARTTLS。授权码只存本机凭据库，不再回显。'))
    }

    // --- the page ----------------------------------------------------------
    function NotifierPage(props) {
      const state = useSnapshot()
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const seeded = useRef(false)

      useEffect(() => {
        void actions.refresh()
      }, [])

      useEffect(() => {
        if (!seeded.current && state.settings) {
          seeded.current = true
          const settings = state.settings
          setDraft({
            enabled: settings.enabled,
            bindEmail: settings.bindEmail,
            smtpHost: settings.smtpHost,
            smtpPort: String(settings.smtpPort),
            smtpSecure: settings.smtpSecure,
            smtpUser: settings.smtpUser,
            smtpPass: '',
            notifyTo: settings.notifyTo,
            subjectPrefix: settings.subjectPrefix,
            includeSummary: settings.includeSummary,
            template: settings.template ?? 'structured',
            includeMetrics: settings.includeMetrics !== false,
            failureAlerts: settings.failureAlerts !== false,
            retryLimit: String(settings.retryLimit ?? 4),
            retryBaseSeconds: String(Math.round((settings.retryBaseMs ?? 60_000) / 1000)),
            quietEnabled: settings.quiet?.enabled === true,
            quietFrom: settings.quiet?.from ?? '22:00',
            quietTo: settings.quiet?.to ?? '08:00',
            digestEnabled: settings.digest?.enabled === true,
            digestAt: settings.digest?.at ?? '09:00',
          })
        }
      }, [state.settings])

      const save = async (verify) => {
        if (draft === null) return
        setBusy(verify ? 'verify' : 'save')
        setNotice(null)
        const body = await actions.saveSettings({
          enabled: draft.enabled,
          bindEmail: draft.bindEmail,
          smtpHost: draft.smtpHost,
          smtpPort: Number.parseInt(draft.smtpPort, 10) || 465,
          smtpSecure: draft.smtpSecure,
          smtpUser: draft.smtpUser,
          smtpPass: draft.smtpPass,
          notifyTo: draft.notifyTo,
          subjectPrefix: draft.subjectPrefix,
          includeSummary: draft.includeSummary,
          template: draft.template,
          includeMetrics: draft.includeMetrics,
          failureAlerts: draft.failureAlerts,
          retryLimit: Math.max(0, Math.min(10, Number.parseInt(draft.retryLimit, 10) || 0)),
          retryBaseMs: Math.max(5, Math.min(3600, Number.parseInt(draft.retryBaseSeconds, 10) || 60)) * 1000,
          quiet: { enabled: draft.quietEnabled, from: draft.quietFrom, to: draft.quietTo },
          digest: { enabled: draft.digestEnabled, at: draft.digestAt },
        }, verify)
        setBusy('')
        setDraft((current) => (current === null ? current : { ...current, smtpPass: '' }))
        setNotice(body.ok
          ? { kind: 'ok', text: verify ? '已保存并发出验证邮件，请查收。' : '设置已保存。' }
          : { kind: 'err', text: body.error ?? '保存失败' })
      }

      const test = async () => {
        setBusy('test')
        setNotice(null)
        const body = await actions.sendTest()
        setBusy('')
        setNotice(body.ok
          ? { kind: 'ok', text: `测试邮件已发往 ${body.to ?? '目标邮箱'}。` }
          : { kind: 'err', text: body.error ?? '发送失败' })
      }

      const setField = (field) => (event) => {
        const raw = event.target.type === 'checkbox' ? event.target.checked : event.target.value
        setDraft((current) => (current === null ? current : { ...current, [field]: raw }))
      }

      const mode = props.mode === 'panel' ? 'panel' : 'page'
      const settings = state.settings
      const ready = settings !== null && draft !== null
      const bound = ready && settings.bindEmail.length > 0 && settings.hasPass && settings.notifyTo.length > 0
      const watches = ready ? (settings.watches ?? []) : []
      const watchedIds = new Set(watches.map(entry => entry.id))
      const sessions = state.sessions ?? []
      const history = ready ? (settings.history ?? []) : []
      const queue = ready
        ? (settings.queue ?? { pending: 0, deferred: 0, buffered: 0 })
        : { pending: 0, deferred: 0, buffered: 0 }

      const head = h('header', { className: 'smn-head' },
        h('div', null,
          h('h2', { className: 'smn-title' }, '完成邮件汇报'),
          h('p', { className: 'smn-sub' },
            '粘贴会话 ID 就能监控它：每完成一轮任务，插件用你绑定的邮箱把完成情况发到目标邮箱。')),
        h('div', { className: 'smn-status' },
          h('span', { className: 'smn-state' },
            h('i', { className: `smn-dot${bound ? ' is-ok' : ''}` }),
            bound ? '邮箱已绑定' : '邮箱未绑定'),
          h('span', { className: 'smn-state' },
            h('i', { className: `smn-dot${watches.length > 0 ? ' is-ok' : ''}` }),
            `监控 ${watches.length}`)))

      if (!ready) {
        return h('div', { className: 'smn-root', 'data-mode': mode },
          h('style', null, CSS),
          head,
          h('div', { className: 'smn-body' },
            h('div', { className: 'smn-stack' },
              h(Card, null, h('div', { className: 'smn-empty' }, state.error ?? '正在读取…')))))
      }

      const sessionChips = sessions.slice(0, 8).map((session) => {
        const on = watchedIds.has(session.id)
        return h('button', {
          key: session.id,
          type: 'button',
          className: `smn-chip${on ? ' smn-chip-on' : ''}`,
          title: session.id,
          onClick: () => void actions.setWatch(session.id, session.title, !on),
        }, session.title.length > 0 ? session.title : session.id.slice(0, 16))
      })

      const body = h('div', { className: 'smn-body' },
        h('div', { className: 'smn-stack' },

          h(Card, { primary: true },
            h(CardHead, {
              title: '监控一个会话',
              hint: '只认会话 ID，不必先打开它。ID 可在会话菜单「复制会话 ID」里拿到。',
            }),
            h(WatchForm, null),
            sessionChips.length > 0
              ? h('div', { className: 'smn-field', style: { gap: '6px' } },
                h('span', { className: 'smn-label' }, '或点选当前活动会话'),
                h('div', { className: 'smn-chips' }, sessionChips))
              : null),

          h(Card, null,
            h(CardHead, {
              title: '发件邮箱',
              hint: '插件用你自己的 SMTP 账号投递，不经过任何中继。',
              actions: h('span', { className: 'smn-state' },
                h('i', { className: `smn-dot${settings.verifiedAt ? ' is-ok' : ''}` }),
                settings.verifiedAt ? `已验证 ${stamp(settings.verifiedAt)}` : '未验证'),
            }),
            h(MailboxForm, {
              draft, setDraft, settings, busy,
              includeToggle: true,
              onSave: save,
              onTest: test,
            })),

          h(Card, null,
            h(CardHead, {
              title: '汇报内容',
              hint: '模板决定正文结构；指标决定是否附带 token 用量与耗时。',
            }),
            h('div', { className: 'smn-grid' },
              h(Labeled, { label: '汇报模板' },
                h('select', { className: 'smn-select', value: draft.template, onChange: setField('template') },
                  h('option', { value: 'structured' }, '结构化：做了什么 / 过程 / 下一步计划'),
                  h('option', { value: 'brief' }, '简报：只给结束状态与执行指标')))),
            h('div', { className: 'smn-row' },
              h(Toggle, {
                label: '附带 token 用量与耗时',
                checked: draft.includeMetrics,
                onChange: (value) => setDraft((current) => ({ ...current, includeMetrics: value })),
              }),
              h(Toggle, {
                label: '失败时发专报',
                checked: draft.failureAlerts,
                onChange: (value) => setDraft((current) => ({ ...current, failureAlerts: value })),
              }),
              h(Toggle, {
                label: '附带回复摘要',
                checked: draft.includeSummary,
                onChange: (value) => setDraft((current) => ({ ...current, includeSummary: value })),
              }))),

          h(Card, null,
            h(CardHead, {
              title: '投递策略',
              hint: '发送失败进重试队列；静默时段内不打扰，结束后汇总一封；日报按天汇总当天完成的任务。',
            }),
            h('div', { className: 'smn-grid' },
              h(Labeled, { label: '失败重试次数' },
                h('input', {
                  className: 'smn-input', value: draft.retryLimit,
                  onChange: setField('retryLimit'), inputMode: 'numeric', placeholder: '4',
                })),
              h(Labeled, { label: '首次重试间隔（秒，之后每次 ×3）' },
                h('input', {
                  className: 'smn-input', value: draft.retryBaseSeconds,
                  onChange: setField('retryBaseSeconds'), inputMode: 'numeric', placeholder: '60',
                }))),
            h('div', { className: 'smn-row' },
              h(Toggle, {
                label: '启用静默时段',
                checked: draft.quietEnabled,
                onChange: (value) => setDraft((current) => ({ ...current, quietEnabled: value })),
              }),
              h(Labeled, { label: '从' },
                h('input', { className: 'smn-input smn-time', type: 'time', value: draft.quietFrom, onChange: setField('quietFrom'), disabled: !draft.quietEnabled })),
              h(Labeled, { label: '到' },
                h('input', { className: 'smn-input smn-time', type: 'time', value: draft.quietTo, onChange: setField('quietTo'), disabled: !draft.quietEnabled }))),
            h('div', { className: 'smn-row' },
              h(Toggle, {
                label: '启用每日日报',
                checked: draft.digestEnabled,
                onChange: (value) => setDraft((current) => ({ ...current, digestEnabled: value })),
              }),
              h(Labeled, { label: '发送时间' },
                h('input', { className: 'smn-input smn-time', type: 'time', value: draft.digestAt, onChange: setField('digestAt'), disabled: !draft.digestEnabled })))),

          h(Card, null,
            h(CardHead, { title: `监控中的会话（${watches.length}）` }),
            watches.length === 0
              ? h('div', { className: 'smn-empty' }, '还没有监控任何会话。')
              : h('div', { className: 'smn-list' }, watches.map((entry) => h('div', { className: 'smn-item', key: entry.id },
                h('div', { className: 'smn-item-main' },
                  h('span', { className: 'smn-item-title' }, entry.title.length > 0 ? entry.title : '(已归档或未知会话)'),
                  h('span', { className: 'smn-mono' }, entry.id)),
                h('div', { className: 'smn-row' },
                  h('span', { className: 'smn-state smn-note' },
                    h('i', { className: `smn-dot${entry.live ? ' is-ok' : ''}` }),
                    entry.live ? '活动中' : '未运行'),
                  h('button', {
                    type: 'button', className: 'smn-btn smn-btn-quiet',
                    onClick: async () => {
                      const result = await actions.reportNow(entry.id)
                      setNotice(result.ok
                        ? { kind: 'ok', text: '已发送该会话的汇报。' }
                        : { kind: 'err', text: result.error ?? '发送失败' })
                    },
                  }, '立即汇报'),
                  h('button', {
                    type: 'button', className: 'smn-btn smn-btn-quiet',
                    onClick: () => void actions.setWatch(entry.id, entry.title, false),
                  }, '移除')))))),

          h(Card, null,
            h(CardHead, {
              title: '最近的汇报',
              hint: queue.pending + queue.deferred + queue.buffered > 0
                ? `待重试 ${queue.pending}　静默暂存 ${queue.deferred}　日报待发 ${queue.buffered}`
                : '每次投递都会记一行，包括暂存与重试。',
              actions: h('div', { className: 'smn-actions' },
                queue.pending + queue.deferred > 0
                  ? h('button', {
                    type: 'button', className: 'smn-btn smn-btn-quiet',
                    onClick: async () => {
                      const result = await actions.flushQueue()
                      setNotice(result.ok
                        ? { kind: 'ok', text: `已处理队列：补发 ${result.retried ?? 0} 封，汇总 ${result.flushed ?? 0} 项。` }
                        : { kind: 'err', text: result.error ?? '处理队列失败' })
                    },
                  }, '立即处理队列')
                  : null,
                queue.pending + queue.deferred > 0
                  ? h('button', {
                    type: 'button', className: 'smn-btn smn-btn-quiet',
                    onClick: async () => {
                      await actions.clearQueue()
                      setNotice({ kind: 'ok', text: '已清空待发队列。' })
                    },
                  }, '清空队列')
                  : null,
                history.length > 0
                  ? h('button', {
                    type: 'button', className: 'smn-btn smn-btn-quiet',
                    onClick: async () => {
                      await actions.clearHistory()
                      setNotice({ kind: 'ok', text: '已清空发送记录。' })
                    },
                  }, '清空记录')
                  : null),
            }),
            history.length === 0
              ? h('div', { className: 'smn-empty' }, '还没有发送记录。')
              : h('table', { className: 'smn-table' },
                h('thead', null, h('tr', null,
                  h('th', null, '时间'), h('th', null, '会话'), h('th', null, '收件'), h('th', null, '结果'))),
                h('tbody', null, history.slice(0, 12).map((entry, index) => h('tr', { key: `${entry.at}-${index}` },
                  h('td', null, stamp(entry.at)),
                  h('td', null, entry.title && entry.title.length > 0 ? entry.title : (entry.sessionId ?? '').slice(0, 14)),
                  h('td', null, entry.to ?? ''),
                  h('td', { className: entry.ok ? 'smn-ok' : (entry.deferred || entry.queued ? 'smn-warn' : 'smn-err') },
                    entry.ok ? '成功' : entry.deferred ? '静默暂存' : entry.queued ? '排队重试' : (entry.error ?? '失败'))))))),

          h(Message, { notice })))

      return h('div', { className: 'smn-root', 'data-mode': mode },
        h('style', null, CSS),
        head,
        body)
    }

    // --- one-click watch on a Session row ----------------------------------
    function SessionRowAction(props) {
      const state = useSnapshot()
      const watched = (state.settings?.watches ?? []).some(entry => entry.id === props.sessionId)
      const [busy, setBusy] = useState(false)
      return h('button', {
        type: 'button',
        className: `smn-row-btn${watched ? ' smn-row-btn-on' : ''}`,
        title: watched ? '取消完成邮件汇报' : '完成后邮件汇报这个会话',
        'aria-label': watched ? '取消完成邮件汇报' : '完成后邮件汇报这个会话',
        'aria-pressed': String(watched),
        disabled: busy,
        onClick: async () => {
          if (busy) return
          setBusy(true)
          await actions.setWatch(props.sessionId, props.displayTitle ?? '', !watched)
          setBusy(false)
        },
      }, h(Envelope, { size: 14 }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Sidebar entrance beside Plugins / Market, and the full page it opens.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'session-mail-notifier',
          order: 40,
          label: '完成邮件汇报',
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'session-mail-notifier',
          inject: () => ({ mode: 'page' }),
        }, NotifierPage))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'session-mail-notifier',
          order: 63,
          label: () => '完成邮件汇报',
          inject: () => ({ mode: 'panel' }),
        }, NotifierPage))

        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action',
          id: 'session-mail-notifier',
          order: 150,
        }, SessionRowAction))

        void actions.refresh()
      },
    }
  },
})
