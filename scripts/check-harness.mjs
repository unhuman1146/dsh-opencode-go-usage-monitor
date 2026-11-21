// Run with the node_modules directory of an installed Harness Web or Desktop runtime.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setImmediate as tick } from 'node:timers/promises'
import * as monitor from '../index.js'

const modules = process.argv[2]
if (!modules) throw new Error('Pass the Harness node_modules directory.')
const load = name => import(pathToFileURL(resolve(modules, '@deepseek-ai', name, 'lib/index.js')).href)
const [{ Context }, { WebServer }, connection] =
  await Promise.all(['cordis', 'dsh-host-webserver', 'dsh-client-connection'].map(load))
const ctx = new Context()
const nativeFetch = globalThis.fetch
const credentials = {
  modifyRecord: async (_, mutate) => mutate(undefined),
  resolve: async ref => ref === 'DSH_MONITOR_SMOKE_KEY' ? { value: 'fixture-only' } : undefined,
}
delete process.env.DSH_MONITOR_SMOKE_KEY
const fibers = []
async function mount(plugin, config) {
  const fiber = ctx.plugin(plugin, config)
  fibers.push(fiber)
  await fiber.await()
  return fiber
}
try {
  await mount(c => { c.reflect.provide('credentials', credentials) })
  await mount(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' })
  await mount(connection)
  const plugin = await mount(monitor, { apiKeyEnv: 'DSH_MONITOR_SMOKE_KEY' })
  await tick()
  const origin = 'http://127.0.0.1:' + ctx.get('webServer').port
  const url = origin + '/plugins/dsh-opencode-go-usage-monitor/usage'
  ctx.get('webServer').register({ kind: 'exact', path: '/', handler(req, res) {
    if (ctx.get('connection').authorizeIndex(req, res)) res.end('ok')
  } })
  let upstreamReads = 0
  globalThis.fetch = async (destination, options) => {
    assert.equal(destination, 'https://opencode.ai/zen/go/v1/usage')
    assert.equal(options.headers.authorization, 'Bearer fixture-only')
    assert.equal(options.redirect, 'error')
    upstreamReads++
    return Response.json({ usage: { weekly: { percent: 15 } } })
  }
  assert.equal((await nativeFetch(url)).status, 401)
  assert.equal(upstreamReads, 0)
  const login = await nativeFetch(ctx.get('connection').authenticatedUrl(origin), { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const result = await nativeFetch(url, { headers: { cookie } })
  assert.equal(result.status, 200)
  assert.equal((await result.json()).windows[0].usedPercent, 15)
  assert.equal((await nativeFetch(url, { method: 'HEAD', headers: { cookie } })).status, 200)
  assert.equal(upstreamReads, 1)
  await plugin.dispose()
  fibers.pop()
  assert.equal((await nativeFetch(url)).status, 404)
  console.log('Harness HTTP integration passed: session admission, authenticated GET/HEAD, cache, route disposal.')
} finally {
  globalThis.fetch = nativeFetch
  for (const fiber of fibers.reverse()) await fiber.dispose()
}
