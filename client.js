/**
 * 套餐余量监控 — browser half.
 *
 * An independent global panel: the sidebar icon selects the `main` panel, so the
 * view is its own screen rather than something embedded in a Conversation. All
 * numbers come from the package's own loopback route
 * (`/plugins/dsh-opencode-go-usage-monitor/usage`); this half never sees the API key and
 * never calls the upstream service directly.
 *
 * `percent` from the upstream endpoint is the USED share of a window, so the big
 * number on each card is the remaining share (100 − used) and the bar fills with
 * the used share.
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-usage-monitor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const PANEL_ID = 'dsh-opencode-go-usage-monitor'
    const NS = 'opencode-go-usage'
    const ROUTE = '/plugins/dsh-opencode-go-usage-monitor/usage'
    const HTTP_TIMEOUT_MS = 12000
    const AUTO_REFRESH_MS = 30000
    /** Background cadence for the sidebar summary while the panel is closed. */
    const SUMMARY_REFRESH_MS = 60000
    const WINDOW_ORDER = ['rolling', 'weekly', 'monthly']

    /* ── copy ───────────────────────────────────────────────────────────────── */

    const ZH = {
      tabLabel: '套餐余量',
      title: '套餐余量',
      subtitle: 'Opencode Go · 每 30 秒自动刷新',
      refresh: '刷新',
      refreshing: '刷新中',
      updatedAt: '更新于',
      never: '尚未读取',
      backToChat: '返回会话',
      rolling: '5h',
      weekly: '本周',
      monthly: '本月',
      used: '已用',
      remaining: '剩余',
      resets: '重置',
      remainPrefix: '还剩',
      resetSoon: '即将重置',
      unitDay: '天',
      unitHour: '小时',
      unitMinute: '分',
      loading: '正在读取…',
      retry: '重试',
      noData: '暂无数据',
      status: '状态',
      sourceNote: '数据来自 opencode.ai/zen/go/v1/usage；只读查询，不消耗额度。',
      errorHint: '读取失败，显示的是上一次成功的数据。',
    }

    const EN = {
      tabLabel: 'Usage',
      title: 'Plan usage',
      subtitle: 'Opencode Go · refreshes every 30s',
      refresh: 'Refresh',
      refreshing: 'Refreshing',
      updatedAt: 'Updated',
      never: 'Not read yet',
      backToChat: 'Back to chat',
      rolling: '5h',
      weekly: 'Week',
      monthly: 'Month',
      used: 'used',
      remaining: 'remaining',
      resets: 'Resets',
      remainPrefix: 'in',
      resetSoon: 'resetting now',
      unitDay: 'd',
      unitHour: 'h',
      unitMinute: 'm',
      loading: 'Reading…',
      retry: 'Retry',
      noData: 'No data',
      status: 'status',
      sourceNote: 'Read-only numbers from opencode.ai/zen/go/v1/usage.',
      errorHint: 'Read failed; showing the last successful numbers.',
    }

    /* ── styles ─────────────────────────────────────────────────────────────── */

    const CSS = `
      @keyframes dsum-pulse { 0%,100% { opacity: .35 } 50% { opacity: .85 } }
      @keyframes dsum-spin { to { transform: rotate(360deg) } }
      .dsum-skeleton { animation: dsum-pulse 1.4s ease-in-out infinite }
      .dsum-spinning { animation: dsum-spin .9s linear infinite }
      .dsum-card { transition: border-color .16s ease, background-color .16s ease }
      .dsum-card:hover { border-color: var(--dsw-alias-border-l2) }
      .dsum-btn { transition: background-color .14s ease, border-color .14s ease, color .14s ease }
      .dsum-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2) }
      .dsum-btn:focus-visible, .dsum-link:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px;
      }
      .dsum-link:hover { color: var(--dsw-alias-label-primary) }
      .dsum-bar > i { transition: width .32s cubic-bezier(.22,.61,.36,1) }
    `

    const S = {
      page: {
        padding: '24px 28px 40px',
        maxWidth: 920,
        margin: '0 auto',
        height: '100%',
        minHeight: 0,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.5,
      },
      head: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
      },
      title: { fontSize: 20, fontWeight: 600, margin: 0, letterSpacing: '-0.01em' },
      subtitle: {
        margin: '4px 0 0',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12.5,
      },
      headActions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      metaText: {
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      btn: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      btnDisabled: { opacity: 0.55, cursor: 'default' },
      linkBtn: {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12.5,
        cursor: 'pointer',
        padding: '4px 2px',
        borderRadius: 6,
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(228px, 1fr))',
        gap: 12,
        marginTop: 18,
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px 12px',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
      },
      cardHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
      },
      cardLabel: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
      dot: { width: 8, height: 8, borderRadius: 999, flex: 'none' },
      bigRow: { display: 'flex', alignItems: 'baseline', gap: 6 },
      big: {
        fontSize: 30,
        fontWeight: 600,
        lineHeight: 1.15,
        letterSpacing: '-0.02em',
        fontVariantNumeric: 'tabular-nums',
      },
      bigUnit: { fontSize: 14, color: 'var(--dsw-alias-label-secondary)' },
      usedLine: {
        marginLeft: 'auto',
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      bar: {
        position: 'relative',
        height: 6,
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2)',
        overflow: 'hidden',
      },
      footRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
      },
      note: {
        marginTop: 20,
        paddingTop: 12,
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
      },
      banner: {
        marginTop: 16,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
      },
      bannerCode: {
        fontVariantNumeric: 'tabular-nums',
        opacity: 0.85,
      },
      empty: {
        marginTop: 18,
        padding: '28px 20px',
        borderRadius: 12,
        border: '1px dashed var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        textAlign: 'center',
        fontSize: 12.5,
      },
    }

    /* ── data ───────────────────────────────────────────────────────────────── */

    function fetchUsage(fresh) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
      return fetch(ROUTE + (fresh ? '?fresh=1' : ''), {
        method: 'GET',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
        .then((response) =>
          response
            .json()
            .catch(() => null)
            .then((body) => {
              if (!response.ok) {
                return {
                  ok: false,
                  error: 'HTTP ' + response.status,
                  url: ROUTE,
                  message: (body && body.message) || '',
                }
              }
              if (!body || typeof body !== 'object') {
                return { ok: false, error: 'BAD_RESPONSE', url: ROUTE, message: '' }
              }
              return body
            }),
        )
        .catch((error) => ({
          ok: false,
          error: error && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
          url: ROUTE,
          message: String((error && error.message) || error || ''),
        }))
        .finally(() => clearTimeout(timer))
    }

    /**
     * Last successful read, shared by the panel and the sidebar entry.
     *
     * The sidebar summary must already be right before the panel was ever opened
     * — and must never disagree with the cards — so one module-level slot holds
     * the newest answer. The panel publishes into it on every successful read, and
     * a background poller keeps it warm while the panel is closed.
     */
    const shared = { latest: null, listeners: new Set() }

    function publishLatest(result) {
      shared.latest = result
      for (const listener of [...shared.listeners]) {
        try {
          listener(result)
        } catch {
          /* a listener must never stop the publisher */
        }
      }
    }

    function subscribeLatest(listener) {
      shared.listeners.add(listener)
      return () => shared.listeners.delete(listener)
    }

    /** Sidebar text: `5h 96% · 本周 99% · 本月 100%`, or '' before the first read. */
    function summaryOf(t) {
      const latest = shared.latest
      if (!latest || !Array.isArray(latest.windows)) return ''
      const parts = []
      for (const id of WINDOW_ORDER) {
        const row = latest.windows.find((entry) => entry.id === id)
        if (!row) continue
        const used = typeof row.usedPercent === 'number' ? row.usedPercent : null
        parts.push(
          t(id) + ' ' + (used === null ? '—' : Math.round(Math.max(0, 100 - used)) + '%'),
        )
      }
      return parts.join(' · ')
    }

    /** One shared background read; a failure leaves the last good numbers alone. */
    let sharedRead = null
    function refreshLatest(fresh) {
      if (sharedRead !== null) return sharedRead
      sharedRead = fetchUsage(fresh)
        .then((result) => {
          if (result && result.ok && Array.isArray(result.windows)) publishLatest(result)
          return result
        })
        .finally(() => {
          sharedRead = null
        })
      return sharedRead
    }

    /* ── formatting ─────────────────────────────────────────────────────────── */

    const pad = (value) => (value < 10 ? '0' + value : String(value))

    function formatDateTime(ms) {
      if (!Number.isFinite(ms)) return '—'
      const date = new Date(ms)
      return (
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate()) +
        ' ' +
        pad(date.getHours()) +
        ':' +
        pad(date.getMinutes())
      )
    }

    function formatRemaining(ms, t) {
      if (!Number.isFinite(ms) || ms <= 0) return t('resetSoon')
      const minutes = Math.floor(ms / 60000)
      if (minutes < 1) return t('resetSoon')
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const mins = minutes % 60
      const parts = []
      if (days > 0) parts.push(days + t('unitDay'))
      if (hours > 0) parts.push(hours + t('unitHour'))
      if (days === 0 && mins > 0) parts.push(mins + t('unitMinute'))
      if (parts.length === 0) parts.push(mins + t('unitMinute'))
      return t('remainPrefix') + ' ' + parts.join(' ')
    }

    /** Tone from the remaining share; an unhealthy window is never painted green. */
    function toneOf(row) {
      const statusOk = !row || !row.status || row.status === 'ok'
      if (!statusOk) return 'var(--dsw-alias-state-warn-primary)'
      const used = row && typeof row.usedPercent === 'number' ? row.usedPercent : null
      if (used === null) return 'var(--dsw-alias-state-idle-primary)'
      const remaining = 100 - used
      if (remaining >= 50) return 'var(--dsw-alias-state-success-primary)'
      if (remaining >= 20) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-error-primary)'
    }

    /* ── components ─────────────────────────────────────────────────────────── */

    function useSecondTick(active) {
      const [now, setNow] = useState(() => Date.now())
      useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [active])
      return now
    }

    function WindowCard({ row, label, t, now }) {
      const used = typeof row.usedPercent === 'number' ? row.usedPercent : null
      const remaining = used === null ? null : Math.max(0, Math.min(100, 100 - used))
      const tone = toneOf(row)
      const resetsMs = row.resetsMs
      return h(
        'div',
        { className: 'dsum-card', style: S.card },
        h(
          'div',
          { style: S.cardHead },
          h('span', { style: S.cardLabel }, label),
          h('span', {
            style: { ...S.dot, background: tone },
            title: t('status') + ': ' + (row.status || 'ok'),
          }),
        ),
        h(
          'div',
          { style: S.bigRow },
          h(
            'span',
            { style: S.big },
            remaining === null ? '—' : String(Math.round(remaining)),
          ),
          h('span', { style: S.bigUnit }, '%'),
          h('span', { style: S.usedLine }, t('used') + ' ' + (used === null ? '—' : Math.round(used) + '%')),
        ),
        h(
          'div',
          { style: S.bar, className: 'dsum-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': used === null ? 0 : Math.round(used) },
          h('i', {
            style: {
              display: 'block',
              height: '100%',
              width: (used === null ? 0 : Math.max(0, Math.min(100, used))) + '%',
              borderRadius: 999,
              background: tone,
            },
          }),
        ),
        h(
          'div',
          { style: S.footRow },
          h('span', null, t('resets') + ' ' + formatDateTime(resetsMs)),
          h('span', null, formatRemaining(resetsMs - now, t)),
        ),
      )
    }

    function SkeletonCard() {
      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: { ...S.bar, height: 10, width: '38%' }, className: 'dsum-skeleton' },
        ),
        h('div', { style: { ...S.bar, height: 30, width: '62%' }, className: 'dsum-skeleton' }),
        h('div', { style: { ...S.bar, height: 6 }, className: 'dsum-skeleton' }),
        h('div', { style: { ...S.bar, height: 10, width: '74%' }, className: 'dsum-skeleton' }),
      )
    }

    function RefreshIcon({ size }) {
      const px = typeof size === 'number' ? size : 14
      return h(
        'svg',
        {
          width: px,
          height: px,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
        h('path', { d: 'M21 3v6h-6' }),
      )
    }

    /** The sidebar glyph: three rising bars inside a gauge, mirroring the three windows. */
    function PanelIcon({ size }) {
      const px = typeof size === 'number' && size > 0 ? size : 16
      return h(
        'svg',
        {
          width: px,
          height: px,
          viewBox: '0 0 64 64',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 5,
          strokeLinecap: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('circle', { cx: 32, cy: 32, r: 23, opacity: 0.45 }),
        h('path', { d: 'M23 44V34' }),
        h('path', { d: 'M32 44V26' }),
        h('path', { d: 'M41 44V38' }),
      )
    }

    function DashboardPage(props) {
      const { t, backToConversation } = props || {}
      // A warm shared snapshot means the panel opens straight into numbers.
      const [view, setView] = useState(() =>
        shared.latest
          ? { status: 'ready', data: shared.latest, error: null }
          : { status: 'loading', data: null, error: null },
      )
      const [busy, setBusy] = useState(false)
      const mountedRef = useRef(true)

      useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
        }
      }, [])

      // Background reads (and the panel's own refresh) share one publisher.
      useEffect(
        () =>
          subscribeLatest((result) => {
            if (mountedRef.current) setView({ status: 'ready', data: result, error: null })
          }),
        [],
      )

      const load = useCallback(
        (fresh) => {
          setBusy(true)
          return fetchUsage(fresh).then((result) => {
            if (!mountedRef.current) return
            setBusy(false)
            if (result && result.ok && Array.isArray(result.windows)) {
              publishLatest(result)
              setView({ status: 'ready', data: result, error: null })
            } else {
              setView((previous) => ({
                status: previous.data ? 'stale' : 'error',
                data: previous.data,
                error: {
                  code: (result && result.error) || 'UNKNOWN',
                  message: (result && result.message) || '',
                  url: (result && result.url) || ROUTE,
                },
              }))
            }
          })
        },
        [],
      )

      useEffect(() => {
        load(false)
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          load(false)
        }, AUTO_REFRESH_MS)
        return () => clearInterval(timer)
      }, [load])

      const rows = view.data && Array.isArray(view.data.windows) ? view.data.windows : []
      const byId = {}
      for (const row of rows) byId[row.id] = row
      const known = WINDOW_ORDER.filter((id) => byId[id])
      const now = useSecondTick(known.length > 0)

      const updatedAt =
        view.data && Number.isFinite(view.data.at) ? formatDateTime(view.data.at) : t('never')

      return h(
        'div',
        { style: S.page },
        h('style', null, CSS),
        h(
          'div',
          { style: S.head },
          h(
            'div',
            null,
            h('h1', { style: S.title }, t('title')),
            h('p', { style: S.subtitle }, t('subtitle')),
          ),
          h(
            'div',
            { style: S.headActions },
            h('span', { style: S.metaText }, t('updatedAt') + ' ' + updatedAt),
            h(
              'button',
              {
                type: 'button',
                className: 'dsum-btn',
                style: { ...S.btn, ...(busy ? S.btnDisabled : null) },
                onClick: () => {
                  if (!busy) load(true)
                },
                disabled: busy,
                title: t('refresh'),
                'aria-label': t('refresh'),
              },
              h('span', { className: busy ? 'dsum-spinning' : undefined, style: { display: 'inline-flex' } },
                h(RefreshIcon, { size: 14 }),
              ),
              t(busy ? 'refreshing' : 'refresh'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsum-link',
                style: S.linkBtn,
                onClick: () => {
                  if (typeof backToConversation === 'function') backToConversation()
                },
              },
              t('backToChat'),
            ),
          ),
        ),
        view.error
          ? h(
              'div',
              { style: S.banner },
              h(
                'span',
                null,
                (view.status === 'stale' ? t('errorHint') + ' ' : '') +
                  (view.error.message || t('noData')),
              ),
              h(
                'span',
                { style: S.bannerCode },
                view.error.code + (view.error.url ? ' · ' + view.error.url : ''),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsum-btn',
                  style: S.btn,
                  onClick: () => load(true),
                },
                t('retry'),
              ),
            )
          : null,
        h(
          'div',
          { style: S.grid },
          known.length > 0
            ? known.map((id) => h(WindowCard, { key: id, row: byId[id], label: t(id), t, now }))
            : view.status === 'loading'
              ? [
                  h(SkeletonCard, { key: 'a' }),
                  h(SkeletonCard, { key: 'b' }),
                  h(SkeletonCard, { key: 'c' }),
                ]
              : h('div', { style: S.empty }, view.status === 'error' ? t('noData') : t('loading')),
        ),
        h('p', { style: S.note }, t('sourceNote')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh: ZH, en: EN }),
          'opencode-go-usage: copy',
        )
        const t = ctx.locale.bind(NS)
        const backToConversation = () => {
          try {
            const layout = ctx.get('layout')
            if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
          } catch {
            /* older shell without the layout service */
          }
        }
        /**
         * The sidebar entry's label doubles as its hover tooltip (and as the row
         * text once the sidebar is expanded), so it carries the live summary
         * instead of the panel name. The shell re-reads a label only when the slot
         * registry or the locale changes, so the entry is re-registered whenever
         * the summary changes: same id, same order, selection untouched, and the
         * label function is re-evaluated by the shell on the next locale change.
         */
        let panellistDispose = null
        let installedSummary = null
        const syncPanellist = () => {
          const summary = summaryOf(t)
          if (summary === installedSummary) return
          installedSummary = summary
          if (panellistDispose !== null) {
            panellistDispose()
            panellistDispose = null
          }
          panellistDispose = ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 55,
                label: () => summaryOf(t) || t('tabLabel'),
                locale: NS,
              },
              PanelIcon,
            ),
          )
        }
        syncPanellist()
        ctx.effect(() => subscribeLatest(() => syncPanellist()), 'opencode-go-usage: sidebar summary')

        /**
         * Keep the summary current before the panel is ever opened, and pause while
         * the page is hidden. One read per minute against the package's own route is
         * cheap; the Host caches the upstream answer for eight seconds.
         */
        ctx.effect(() => {
          const prime = setTimeout(() => {
            refreshLatest(false)
          }, 1200)
          const timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return
            refreshLatest(false)
          }, SUMMARY_REFRESH_MS)
          return () => {
            clearTimeout(prime)
            clearInterval(timer)
          }
        }, 'opencode-go-usage: background reads')

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: () => ({ t, backToConversation }),
            },
            DashboardPage,
          ),
        )
      },
    }
  },
})
