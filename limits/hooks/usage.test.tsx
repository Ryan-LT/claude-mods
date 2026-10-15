import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'limits',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

test('one compact line: limit, bar, percent, reset or run-out', async ($, on) => {
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  await $.session.measure({
    context: { tokens: 84_200, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 61, resetsAt: inHours(72) },
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: inHours(2) },
    ],
    cost: { usd: 1.234 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 62.5, resetsAt: inHours(72) },
      { kind: 'five_hour', percentUsed: 27, resetsAt: inHours(2) },
    ],
    changed: ['rateLimits'],
  })

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: 'Context ' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '84.2k/200k' })).toBeDefined()
  for (const text of ['5-hour', 'Weekly', '27%', '63%', /2h/, /[23]d/]) {
    expect(await term.find({ type: 'Text', text })).toBeDefined()
  }
  expect(await term.find({ type: 'Text', text: /out / })).toBeUndefined()
  const weekly = (await term.findAll({ type: 'Text', text: ' 63%' }))[0] as unknown as { props: { color?: string } }
  expect(weekly.props.color).toBe('error')
  for (const text of [/COST|session|budget/]) {
    expect(await term.find({ type: 'Text', text })).toBeUndefined()
  }
  await term.unmount()

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desk.findAll({ type: 'Svg' })).toHaveLength(1)
  await desk.unmount()
})

test('band waits politely before any reading', async ($, on) => {
  mock.store(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /after the first reply/ })).toBeDefined()
  await ui.unmount()
})

test('refresh button pings once, takes the new reading, and never pins a status line', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.now() })
  const statuses: (string | undefined)[] = []
  let pings = 0
  let reading = [{ kind: 'five_hour', percentUsed: 20, resetsAt: inHours(3) }]
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('model.complete', () => {
    pings += 1
    reading = [{ kind: 'five_hour', percentUsed: 92, resetsAt: inHours(3) }]
    return { value: { isAnswered: true, text: '.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: reading } }) as never)

  await $.session.measure({ context: { window: 200_000 }, rateLimits: reading, changed: ['rateLimits'] })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'refresh' })
  expect(pings).toBe(1)
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(statuses.filter(t => t !== undefined)).toHaveLength(0)
  await ui.unmount()
})

test('a reading that names only one window keeps the other on the bar', async ($, on) => {
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }) as never)
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 20, resetsAt: inHours(3) },
      { kind: 'seven_day', percentUsed: 80, resetsAt: inHours(30) },
    ],
    changed: ['rateLimits'],
  })
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 81, resetsAt: inHours(30) }],
    changed: ['rateLimits'],
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '5-hour ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 81%' })).toBeDefined()
  await ui.unmount()
})

test('auto refresh asks once per 2-minute slot while idle', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.now() })
  let pings = 0
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('model.complete', () => {
    pings += 1
    return { value: { isAnswered: true, text: '.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: inHours(3) }] } }) as never)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await clock.advance(10 * 60_000)
  // Ten minutes is five slots; the first may already hold the start's own reading.
  expect(pings).toBeGreaterThanOrEqual(4)
  expect(pings).toBeLessThanOrEqual(6)
})

test('a chat that never saw session.start still pulls the shared reading and shows both limits', async ($, on) => {
  const at = Date.now()
  mock.store(on, {
    latest: {
      limits: [
        { kind: 'five_hour', percentUsed: 9, resetsAt: inHours(4) },
        { kind: 'seven_day', percentUsed: 83, resetsAt: inHours(30) },
      ],
      at,
    },
    lastSlot: Math.floor(at / 120_000),
  })
  const clock = mock.clock(on, { now: at })
  on('ui.toast', () => ({ value: undefined }) as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(1_000)
  await ui.unmount()
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: '5-hour ' })).toBeDefined()
  expect(await again.find({ type: 'Text', text: ' 83%' })).toBeDefined()
  await again.unmount()
})

test('a stale figure handed over later never pulls a window back down', async ($, on) => {
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', () => ({ value: undefined }) as never)
  const week = inHours(9)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 94, resetsAt: week }], changed: ['rateLimits'] })
  // An idle chat reports what it last saw, hours ago, for the same week.
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 87, resetsAt: week }], changed: ['rateLimits'] })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' 94%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 87%' })).toBeUndefined()
  await ui.unmount()
  // A new week starts lower, and that does replace it.
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 3, resetsAt: inHours(9 + 168) }], changed: ['rateLimits'] })
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: ' 3%' })).toBeDefined()
  await after.unmount()
})

test('a live reading lower than the stored one replaces it (plan upgrade mid-week)', async ($, on) => {
  const week = inHours(147)
  const at = Date.now()
  mock.store(on, { latest: { limits: [{ kind: 'seven_day', percentUsed: 26, resetsAt: week }], at } })
  mock.clock(on, { now: at + 60_000 })
  let reading = [{ kind: 'seven_day', percentUsed: 26, resetsAt: week }]
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('model.complete', () => {
    reading = [{ kind: 'seven_day', percentUsed: 10, resetsAt: week }]
    return { value: { isAnswered: true, text: '.', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } as never
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: reading } }) as never)

  await $.session.measure({ context: { window: 200_000 }, rateLimits: reading, changed: ['rateLimits'] })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' 26%' })).toBeDefined()
  await ui.press({ key: 'refresh' })
  await ui.unmount()
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: ' 10%' })).toBeDefined()
  expect(await after.find({ type: 'Text', text: ' 26%' })).toBeUndefined()
  await after.unmount()

  // An idle chat replaying its pre-upgrade figure does not bring it back.
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 26, resetsAt: week }], changed: ['rateLimits'] })
  const replay = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await replay.find({ type: 'Text', text: ' 10%' })).toBeDefined()
  await replay.unmount()
})
