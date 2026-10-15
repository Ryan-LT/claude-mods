import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000

const setup = (on: Parameters<Parameters<typeof test>[1]>[1], tokens: number) => {
  const seen = { compacts: 0 }
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000 }, rateLimits: [] } }) as never)
  on('session.compact', () => {
    seen.compacts += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: tokens, tokensAfter: 20_000 } as never
  })
  return seen
}

const reply = ($: any) =>
  $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, answer: 'done', durationMs: 1 } as never)

test('a big chat is compacted once after 40 idle minutes', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const seen = setup(on, 300_000)
  await reply($)
  await clock.advance(39 * MINUTE)
  expect(seen.compacts).toBe(0)
  await clock.advance(2 * MINUTE)
  expect(seen.compacts).toBe(1)
  await clock.advance(60 * MINUTE)
  expect(seen.compacts).toBe(1)
})

test('a small chat is left alone', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const seen = setup(on, 80_000)
  await reply($)
  await clock.advance(45 * MINUTE)
  expect(seen.compacts).toBe(0)
})

test('a subagent finishing does not count as a reply', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const seen = setup(on, 300_000)
  await $.turn.complete({ turnId: 't2', agentId: 'a1', reason: 'answer', isAborted: false, answer: 'done', durationMs: 1 } as never)
  await clock.advance(45 * MINUTE)
  expect(seen.compacts).toBe(0)
})
