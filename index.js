/**
 * 套餐余量监控 — Host half.
 *
 * Why the read lives on the Host: the panel's data comes from
 * `https://opencode.ai/zen/go/v1/usage`, which needs the OPENCODE_GO_API_KEY
 * credential. That credential belongs to the Host process (it may come from the
 * managed credential store, not from the environment), and handing it to the page
 * would put it in browser memory. So the Host owns both the key and the upstream
 * call; the page only sees the numbers that come back.
 *
 * One exact loopback route answers the panel:
 *   GET /plugins/dsh-opencode-go-usage-monitor/usage[?fresh=1]
 *
 * A short Host-side cache keeps an auto-refreshing panel from turning into a
 * request burst against the upstream endpoint; `fresh=1` is the manual-refresh
 * bypass.
 */

const ROUTE = '/plugins/dsh-opencode-go-usage-monitor/usage'
const ENDPOINT =
  (process.env.OPENCODE_GO_USAGE_ENDPOINT || '').trim() ||
  'https://opencode.ai/zen/go/v1/usage'
const KEY_REF = 'OPENCODE_GO_API_KEY'
const WINDOWS = ['rolling', 'weekly', 'monthly']
const UPSTREAM_TIMEOUT_MS = 12000
/** How long one upstream answer is reused for auto-refresh reads. */
const CACHE_TTL_MS = 8000

const decimal = /^-?\d+(?:\.\d+)?$/

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Only the loopback page may talk to this route.
 *
 * Any website can reach 127.0.0.1 (DNS rebinding walks around the same-origin
 * policy), so the socket peer plus the Host header are checked. The real page is
 * served by DSH on loopback, so this costs it nothing.
 */
function localRequest(req) {
  const remote = String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '')
  const peerOk =
    remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const host = String(req.headers.host || '').toLowerCase()
  const hostOk =
    host === '127.0.0.1' ||
    host.startsWith('127.0.0.1:') ||
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    host === '[::1]' ||
    host.startsWith('[::1]:')
  return peerOk && hostOk
}

/** Resolve the provider credential: process environment first, then the store. */
async function resolveApiKey(ctx) {
  const fromEnv = String(process.env[KEY_REF] || '').trim()
  if (fromEnv.length > 0) return fromEnv
  const credentials = ctx.get('credentials')
  if (credentials === undefined || credentials === null) return ''
  try {
    const hit = await credentials.resolve(KEY_REF)
    const value = hit && typeof hit === 'object' ? hit.value : hit
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

/** Normalise one upstream window; `percent` is the used share, 0–100. */
function normaliseWindow(id, raw) {
  const row = raw && typeof raw === 'object' ? raw : {}
  const used = Number(row.percent)
  const resetsAt = typeof row.resetsAt === 'string' ? row.resetsAt : ''
  const resetsMs = resetsAt ? Date.parse(resetsAt) : NaN
  return {
    id,
    status: typeof row.status === 'string' ? row.status : 'ok',
    usedPercent: Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null,
    resetsAt,
    resetsMs: Number.isFinite(resetsMs) ? resetsMs : null,
  }
}

async function readUpstream(ctx) {
  const key = await resolveApiKey(ctx)
  if (key.length === 0) {
    return {
      ok: false,
      error: 'NO_KEY',
      message:
        '没有找到 ' +
        KEY_REF +
        '：请在「设置 → 模型」里配置 opencode-go 的 key，或在环境变量里导出它。',
    }
  }

  let response
  try {
    response = await fetch(ENDPOINT, {
      method: 'GET',
      headers: {
        authorization: 'Bearer ' + key,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (error) {
    return {
      ok: false,
      error: 'NETWORK',
      message: String((error && error.message) || error),
    }
  }

  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!response.ok) {
    return {
      ok: false,
      error: 'HTTP ' + response.status,
      message: text.slice(0, 200),
    }
  }
  const usage = json && typeof json === 'object' ? json.usage : null
  if (!usage || typeof usage !== 'object') {
    return {
      ok: false,
      error: 'BAD_PAYLOAD',
      message: '上游返回里没有 usage 字段：' + text.slice(0, 200),
    }
  }

  const windows = []
  for (const id of WINDOWS) {
    if (usage[id] === undefined) continue
    windows.push(normaliseWindow(id, usage[id]))
  }
  if (windows.length === 0) {
    return {
      ok: false,
      error: 'NO_WINDOWS',
      message: '上游 usage 里没有任何已知窗口（rolling / weekly / monthly）。',
    }
  }
  return { ok: true, at: Date.now(), windows }
}

export function apply(ctx) {
  /** Last successful answer and when it was produced, for the auto-refresh path. */
  let cache = null
  let cacheAt = 0
  /** Serialise upstream reads: a burst of tabs must not become a burst of calls. */
  let inflight = null

  async function readUsage(fresh) {
    const now = Date.now()
    if (!fresh && cache !== null && now - cacheAt < CACHE_TTL_MS) return cache
    if (inflight !== null) return inflight
    inflight = (async () => {
      try {
        const result = await readUpstream(ctx)
        if (result.ok) {
          cache = result
          cacheAt = Date.now()
        }
        return result
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  async function handler(req, res) {
    if (!localRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const fresh = url.searchParams.get('fresh') === '1'
    try {
      const result = await readUsage(fresh)
      return sendJson(res, 200, result)
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: 'INTERNAL',
        message: String((error && error.message) || error),
      })
    }
  }

  ctx.inject(['webServer'], (host) => {
    const server = host.webServer || (host.get && host.get('webServer'))
    if (!server) return
    host.effect(() => {
      const off = server.register({ kind: 'exact', path: ROUTE, handler })
      return () => {
        off()
        cache = null
        cacheAt = 0
      }
    }, 'opencode-go-usage: route')
  })
}
