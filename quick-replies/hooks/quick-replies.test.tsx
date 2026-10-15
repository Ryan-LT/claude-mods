import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { byRules, isWorthAsking, parseReplies } from './register'

const BAND = {
  plugin: 'quick-replies',
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

const USAGE = { input_tokens: 300, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** Haiku answering `text`; counts the asks and keeps the last prompt. */
const haiku = (on: On, text: string) => {
  const asks = { n: 0, prompt: '' }
  on('model.complete', ($, e) => {
    asks.n += 1
    asks.prompt = e.prompt
    return { value: { isAnswered: true, text, usage: USAGE } } as never
  })
  return asks
}

/** Runs one main-loop turn that ends with `answer`, and lets the suggestion land. */
const turn = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, id: string, prompt: string, answer: string) => {
  await $.turn.start({ text: prompt, turnId: id })
  await $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: id, reason: 'answer' })
  await clock.advance(0)
}

const base = (on: On) => {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
}

test('pills from the reply: a click sends the reply as the person', async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  const asks = haiku(on, '```json\n["Yes, do it", "Not now", "Show the diff first"]\n```')
  const sent: string[] = []
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await turn($, clock, 't1', 'fix the bar', 'The fix is ready. Want me to commit and push it?')
  expect(asks.n).toBe(1)
  expect(asks.prompt).toContain('fix the bar')
  expect(asks.prompt).toContain('Want me to commit')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'reply-0' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Not now' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Show the diff first' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'reply-0' })
  expect(sent).toEqual(['Yes, do it'])
  expect(await ui.find({ key: 'reply-0' })).toBeUndefined()
  await ui.unmount()
})

test('a finished report with nothing to answer costs nothing and shows nothing', async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  const asks = haiku(on, '["Yes"]')
  await turn($, clock, 't1', 'rename it', 'Renamed `foo` to `bar` in 3 files. Tests pass.')
  expect(asks.n).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('hidden while a turn runs, gone when the next one starts, ✕ dismisses', async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  haiku(on, '["Yes", "No"]')
  await turn($, clock, 't1', 'go', 'Should I delete the old branch?')

  const working = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })
  expect(await working.find({ type: 'Button' })).toBeUndefined()
  await working.unmount()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: 'Yes' })).toBeDefined()
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Button', text: 'Yes' })).toBeUndefined()
  await ui.unmount()

  await turn($, clock, 't2', 'go', 'Should I delete the old branch?')
  await $.turn.start({ text: 'something else', turnId: 't3' })
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Button' })).toBeUndefined()
  await after.unmount()
})

test('when Haiku fails, the patterns answer', async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'aborted', usage: USAGE } }) as never)
  await turn($, clock, 't1', 'deploy', 'Ready to deploy to production. Confirm?')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: 'Confirm' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Cancel' })).toBeDefined()
  await ui.unmount()
})

test('rules mode never calls a model', { options: { mode: 'rules' } }, async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  const asks = haiku(on, '["Yes"]')
  await turn($, clock, 't1', 'x', 'Restart the app, then check the bar yourself and let me know.')
  expect(asks.n).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: 'Check it for me' })).toBeDefined()
  await ui.unmount()
})

test("Claude Code's own next-prompt guess joins the pills, after Haiku's", async ($, on) => {
  const clock = mock.clock(on)
  base(on)
  haiku(on, '["Yes", "No"]')
  on('prompt.suggest', () => ({ isShown: true }))
  await turn($, clock, 't1', 'x', 'Want me to open a PR?')
  await $.prompt.suggest({ text: 'open the PR', origin: { kind: 'suggestion' } } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'reply-0', type: 'Button', text: 'Yes' })).toBeDefined()
  expect(await ui.find({ key: 'reply-2', type: 'Button', text: 'open the PR' })).toBeDefined()
  await ui.unmount()
})

test('patterns, parsing and the cheap gate', () => {
  expect(byRules('Done. Want me to push it?')).toEqual(['Yes', 'No'])
  expect(byRules('Which one?\n1. **Haiku** — cheap\n2. **Rules** — free')).toEqual(['Haiku', 'Rules'])
  expect(byRules('Run this:\n```bash\nnpm test\n```')).toEqual(['Check it for me'])
  expect(parseReplies('Sure: ["A", "a", " B ", 3, "' + 'x'.repeat(60) + '"]')).toEqual(['A', 'B'])
  expect(parseReplies('no list here')).toBeNull()
  expect(isWorthAsking('All done, tests pass.')).toBe(false)
  expect(isWorthAsking('Should I also update the README?')).toBe(true)
})
