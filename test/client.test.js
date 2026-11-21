import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setImmediate as tick } from 'node:timers/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function mount() {
  let plugin, dashboard, sidebar, mounting = true
  const states = [], effects = [], pending = [], intervals = new Map()
  let cursor = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const id = cursor++
      if (mounting) states[id] = typeof initial === 'function' ? initial() : initial
      return [states[id], next => { states[id] = next }]
    },
    useEffect(fn) { if (mounting) effects.push(fn) },
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => react) } } },
    AbortController, setTimeout: () => 0, clearTimeout() {},
    setInterval(fn, ms) { intervals.set(ms, fn); return ms }, clearInterval() {},
    fetch(url) { return new Promise(resolve => pending.push({ url, resolve })) },
  })
  plugin.apply({
    effect: fn => fn(),
    locale: { register() {}, bind: () => key => key },
    slots: {
      inject: (_, fn) => fn(),
      register(options, component) {
        if (options.name === 'main') dashboard = component
        else sidebar = options
        return () => {}
      },
    },
  })
  function render() {
    cursor = 0
    const tree = dashboard({ t: key => key })
    mounting = false
    for (const fn of effects.splice(0)) fn()
    return tree
  }
  async function deliver(index, data) {
    pending[index].resolve({ ok: true, json: async () => data })
    await tick()
  }
  return { render, deliver, pending, intervals, summary: () => sidebar.label() }
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return
  if (predicate(tree)) return tree
  for (const child of tree.children?.flat() ?? []) {
    const found = find(child, predicate)
    if (found) return found
  }
}

const sample = (at, usedPercent, resetsMs = null) => ({
  ok: true, at, windows: [{ id: 'rolling', usedPercent, resetsMs, status: 'ok' }],
})

for (const [name, delayed] of [['success', sample(1, 90)], ['failure', { ok: false, error: 'NETWORK' }]]) {
  test('delayed automatic ' + name + ' cannot replace a manual refresh', async () => {
    const ui = mount()
    const tree = ui.render()
    ui.intervals.get(60000)()
    assert.equal(ui.pending.length, 1)
    find(tree, el => el.props?.title === 'refresh').props.onClick()
    ui.intervals.get(30000)()
    assert.equal(ui.pending.length, 2)
    assert.match(ui.pending[1].url, /fresh=1$/)
    await ui.deliver(1, sample(2, 10))
    await ui.deliver(0, delayed)
    const settled = ui.render()
    assert.equal(ui.summary(), 'rolling 90%')
    assert.equal(find(settled, el => el.type?.name === 'WindowCard').props.row.usedPercent, 10)
    assert.equal(find(settled, el => el.children?.includes('retry')), undefined)
    assert.equal(find(settled, el => el.props?.title === 'refresh').props.disabled, false)
  })
}

test('missing reset is unknown; an elapsed known reset is due', async () => {
  const ui = mount()
  ui.render()
  await ui.deliver(0, sample(1, null))
  const component = () => {
    const card = find(ui.render(), el => el.type?.name === 'WindowCard')
    return card.type(card.props)
  }
  assert.equal(ui.summary(), 'rolling —')
  assert.equal(find(component(), el => el.children?.includes('resetSoon')), undefined)
  assert.equal(find(component(), el => el.props?.role === 'progressbar').props['aria-valuenow'], undefined)
  ui.intervals.get(30000)()
  await ui.deliver(1, sample(2, 0, 1))
  assert.ok(find(component(), el => el.children?.includes('resetSoon')))
})
