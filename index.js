import { createHash } from 'node:crypto'

const ROUTE = '/plugins/dsh-opencode-go-usage-monitor/usage'
const ENDPOINT = 'https://opencode.ai/zen/go/v1/usage'
const DEFAULT_KEY_REF = 'OPENCODE_GO_API_KEY'
const WINDOWS = ['rolling', 'weekly', 'monthly']
const UPSTREAM_TIMEOUT_MS = 12000
const CACHE_TTL_MS = 8000

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host ?? '')
}

function credentialRef(ctx, override) {
  if (override !== undefined) return override
  const settings = ctx.get('settings')
  if (!settings) return DEFAULT_KEY_REF
  const provider = ctx.get('llm')?.listConfigurableProviders?.()
    .find((entry) => entry.provider === 'opencode-go')
  const namespace = provider?.settingsNs ?? 'llm-pi-ai'
  const path = provider?.settingsPath ?? ['providers', 'opencode-go']
  const section = settings.describe({ redactSecrets: true }).find((row) => row.ns === namespace)
  let profile = section?.value
  for (const field of path) profile = profile?.[field]
  return profile?.apiKeyEnv ?? DEFAULT_KEY_REF
}

async function resolveApiKey(ctx, override) {
  const ref = credentialRef(ctx, override)
  if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return ''
  const fromEnv = process.env[ref]?.trim()
  if (fromEnv) return fromEnv
  const hit = await ctx.get('credentials')?.resolve(ref)
  const value = typeof hit === 'string' ? hit : hit?.value
  return typeof value === 'string' ? value.trim() : ''
}

function normaliseWindow(id, row) {
  const percent = row?.percent
  // Older providers may return an ordinary decimal string.
  const used = typeof percent === 'string' && /^\d+(?:\.\d+)?$/.test(percent)
    ? Number(percent) : percent
  const reset = row?.resetsAt
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i
  const resetsMs = typeof reset === 'string' && timestamp.test(reset) ? Date.parse(reset) : NaN
  const validReset = Number.isFinite(resetsMs)
  return {
    id,
    status: row?.status === undefined || row?.status === 'ok' ? 'ok' : 'unknown',
    usedPercent: Number.isFinite(used) && used >= 0 && used <= 100 ? used : null,
    resetsAt: validReset ? new Date(resetsMs).toISOString() : '',
    resetsMs: validReset ? resetsMs : null,
  }
}

async function readUpstream(key) {
  let response
  try {
    response = await fetch(ENDPOINT, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: 'NETWORK', message: '无法连接到 OpenCode Go 用量服务。' }
  }
  if (!response.ok) {
    await response.body?.cancel()
    return { ok: false, error: 'HTTP ' + response.status, message: 'OpenCode Go 用量服务返回错误。' }
  }

  let usage
  try {
    usage = (await response.json())?.usage
  } catch {
    // The response may be incomplete or non-JSON.
  }
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return { ok: false, error: 'BAD_PAYLOAD', message: '用量服务返回了无法识别的数据。' }
  }
  const windows = WINDOWS.filter((id) => Object.hasOwn(usage, id))
    .map((id) => normaliseWindow(id, usage[id]))
  if (!windows.length) {
    return { ok: false, error: 'NO_WINDOWS', message: '用量服务未返回已知的统计窗口。' }
  }
  return { ok: true, at: Date.now(), windows }
}

export function apply(ctx, config = {}) {
  ctx.inject(['webServer', 'connection'], (host) => {
    let account
    async function readUsage(fresh) {
      const key = await resolveApiKey(host, config.apiKeyEnv)
      if (!key) {
        account = undefined
        return { ok: false, error: 'NO_KEY', message: '请检查 opencode-go 的凭据引用及对应的密钥。' }
      }
      const identity = createHash('sha256').update(key).digest('hex')
      if (account?.identity !== identity) account = { identity, cache: null, inflight: null }
      const state = account
      if (state.inflight) return state.inflight
      if (!fresh && state.cache && Date.now() - state.cache.at < CACHE_TTL_MS) return state.cache
      state.inflight = readUpstream(key).then((result) => {
        if (result.ok) state.cache = result
        return result
      }).finally(() => { state.inflight = null })
      return state.inflight
    }

    async function handler(req, res) {
      try {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
        const admission = host.connection.admit(req)
        if ('rejection' in admission) {
          const status = admission.rejection === 401 ? 401 : 403
          return sendJson(res, status, { ok: false, error: status === 401 ? 'unauthorized' : 'forbidden' })
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        }
        const url = new URL(req.url, 'http://127.0.0.1')
        return sendJson(res, 200, await readUsage(url.searchParams.get('fresh') === '1'))
      } catch {
        return sendJson(res, 500, { ok: false, error: 'INTERNAL', message: '宿主读取用量失败。' })
      }
    }

    host.effect(() => host.webServer.register({ kind: 'exact', path: ROUTE, handler }), 'opencode-go-usage: route')
  })
}
