import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

const official = 'https://opencode.ai/zen/go/v1/usage'
const valid = { usage: { weekly: { percent: 25, resetsAt: '2026-12-01T00:00:00Z' } } }

function fixture(t, options = {}) {
  let handler
  const services = {
    credentials: { resolve: async () => ({ value: 'fixture-only' }) },
    ...options.services,
  }
  const host = {
    connection: { admit: () => options.admission ?? { peer: {} } },
    webServer: { register(route) { handler = route.handler; return () => {} } },
    effect: (setup) => setup(),
    get: (name) => services[name],
  }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init })
    return options.respond ? options.respond() : Response.json(valid)
  })
  const activate = options.activate ?? apply
  activate({ inject(names, mount) {
    assert.deepEqual(names, ['webServer', 'connection'])
    mount(host)
  } }, { apiKeyEnv: 'DSH_AUDIT_TEST_REF', ...options.config })
  async function read({ method = 'GET', url = '/usage', remoteAddress = '127.0.0.1' } = {}) {
    let status, body
    await handler({ method, url, headers: { host: 'localhost' }, socket: { remoteAddress } },
      { writeHead(value) { status = value }, end(text) { body = JSON.parse(text) } })
    return { status, body }
  }
  return { read, calls }
}

test('requires Host admission before accessing quota, including cached reads', async t => {
  const admission = { peer: {} }
  const { read, calls } = fixture(t, { admission })
  assert.equal((await read()).status, 200)
  for (const status of [401, 403]) {
    admission.rejection = status
    assert.equal((await read()).status, status)
    assert.equal(calls.length, 1)
  }
  delete admission.rejection
  assert.equal((await read({ remoteAddress: '192.0.2.1' })).status, 403)
  assert.equal((await read({ method: 'POST' })).status, 405)
})

test('production URL is fixed even with a legacy override, redirects are refused', async t => {
  const original = process.env.OPENCODE_GO_USAGE_ENDPOINT
  process.env.OPENCODE_GO_USAGE_ENDPOINT = 'https://unused.invalid/'
  try {
    // Load a fresh instance because the previous implementation sampled the override on import.
    const { apply: mount } = await import('../index.js?fixed-destination')
    const { read, calls } = fixture(t, { activate: mount })
    assert.equal((await read()).body.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, official)
    assert.equal(calls[0].init.redirect, 'error')
  } finally {
    if (original === undefined) delete process.env.OPENCODE_GO_USAGE_ENDPOINT
    else process.env.OPENCODE_GO_USAGE_ENDPOINT = original
  }
})

for (const [name, respond, code] of [
  ['HTTP error', () => new Response('private-diagnostic', { status: 429 }), 'HTTP 429'],
  ['invalid JSON', () => new Response('private-diagnostic'), 'BAD_PAYLOAD'],
  ['unexpected payload', () => Response.json({ private: 'private-diagnostic' }), 'BAD_PAYLOAD'],
  ['network error', () => { throw Error('private-diagnostic') }, 'NETWORK'],
]) {
  test(name + ' exposes only a safe message', async t => {
    const { read } = fixture(t, { respond })
    const { body } = await read()
    assert.equal(body.error, code)
    assert.doesNotMatch(JSON.stringify(body), /private-diagnostic/)
  })
}

test('valid zero and decimal percentages survive, invalid values and reset dates stay unknown', async t => {
  let percent
  const { read } = fixture(t, { respond: () => Response.json({ usage: { rolling: { percent, resetsAt: 'invalid' } } }) })
  for (const [value, expected] of [[0,0], [100,100], ['12.5',12.5], [null,null], [false,null], ['',null], [[],null], [-1,null], [101,null], [undefined,null]]) {
    percent = value
    const { body } = await read({ url: '/usage?fresh=1' })
    assert.equal(body.windows[0].usedPercent, expected)
    assert.equal(body.windows[0].resetsMs, null)
  }
})

test('uses the provider settings namespace and path; missing named key never falls back', async t => {
  const refs = []
  let value = 'custom-fixture'
  const { read, calls } = fixture(t, { config: { apiKeyEnv: undefined }, services: {
    llm: { listConfigurableProviders: () => [{ provider: 'opencode-go', settingsNs: 'adapter', settingsPath: ['profiles', 'go'] }] },
    settings: { describe: () => [{ ns: 'adapter', value: { profiles: { go: { apiKeyEnv: 'DSH_TEST_CUSTOM_REF' } } } }] },
    credentials: { resolve: async ref => { refs.push(ref); return { value } } },
  } })
  assert.equal((await read()).body.ok, true)
  value = undefined
  assert.equal((await read()).body.error, 'NO_KEY')
  assert.deepEqual(refs, ['DSH_TEST_CUSTOM_REF', 'DSH_TEST_CUSTOM_REF'])
  assert.equal(calls[0].init.headers.authorization, 'Bearer custom-fixture')
})

test('explicit reference supports isolated profiles and key rotation invalidates cached usage', async t => {
  let value = 'first-fixture'
  const { read, calls } = fixture(t, { services: { credentials: { async resolve(ref) {
    assert.equal(ref, 'DSH_AUDIT_TEST_REF')
    return { value }
  } } } })
  await Promise.all([read(), read(), read()])
  await read()
  assert.equal(calls.length, 1)
  value = 'second-fixture'
  await read()
  assert.equal(calls.length, 2)
  await read({ url: '/usage?fresh=1' })
  assert.equal(calls.length, 3)
})


test('default reference works without model settings', async t => {
  const ref = 'OPENCODE_GO_API_KEY'
  const previous = process.env[ref]
  process.env[ref] = 'local-test-fixture'
  try {
    const { read, calls } = fixture(t, { config: { apiKeyEnv: undefined } })
    const { body } = await read()
    assert.equal(body.windows[0].resetsMs, Date.parse(valid.usage.weekly.resetsAt))
    assert.equal(calls[0].init.headers.authorization, 'Bearer local-test-fixture')
  } finally {
    if (previous === undefined) delete process.env[ref]
    else process.env[ref] = previous
  }
})

test('a credential store failure returns a fixed internal error', async t => {
  const { read, calls } = fixture(t, { services: { credentials: { resolve() { throw Error('private-diagnostic') } } } })
  const { status, body } = await read()
  assert.equal(status, 500)
  assert.equal(body.error, 'INTERNAL')
  assert.doesNotMatch(body.message, /private-diagnostic/)
  assert.equal(calls.length, 0)
})
