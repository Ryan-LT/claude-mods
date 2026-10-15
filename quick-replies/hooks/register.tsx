import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const suggestions = atom({ plugin: 'quick-replies', key: 'suggestions' } as const, null)

const MAX_REPLIES = 4
const MAX_LENGTH = 40
/** How much of the reply's end is read: where the question or the offer is. */
const TAIL = 2500
const ASK_TIMEOUT = 10_000

/** The reply asks, offers or waits on the person. */
const ASKS =
  /\?|\b(want me to|should i|shall i|would you like|do you want|let me know|confirm|go ahead|ready to|prefer|approve|ok to|okay to|your call)\b/i
/** The reply hands the person a step to do themselves. */
const HANDS_OFF =
  /```(bash|sh|zsh|shell)\b|\b(yourself|on your end|manually|in your terminal|and let me know|then tell me)\b/i
const YES_NO = /\b(want me to|should i|shall i|do you want|would you like|ok to|okay to|ready to|is that ok|sound good)\b[^?]*\?/i
const CONFIRM = /\b(confirm|proceed|go ahead)\b[^?]*\?/i
/** A numbered choice, its name: `1. **Name** — why` or `2) Name: why`. */
const CHOICE = /^\s*(\d)[.)]\s+(?:\*\*([^*\n]{1,40})\*\*|([^\n:—–(]{1,40}))/gm

const SYSTEM = `You write the quick-reply buttons of a chat app where a person works with an AI coding assistant.
Given the assistant's latest message, return the replies the person is most likely to send next, best first, as a JSON array of strings.
- At most ${MAX_REPLIES} replies, each 1 to 5 words, written as the person would type it, in the language the person writes in.
- Answer what the message asks. A yes/no or confirm question: "Yes" / "No" (or "Confirm" / "Cancel"). An offer to do something: "Yes, do it", "Not now". Named choices or numbered options: the choices themselves, short.
- If the message tells the person to run, check, open, restart or verify something themselves, include "Check it for me" (or "Do it for me" when it is an action).
- A useful follow-up is fine when the message clearly invites one (for example "Commit it", "Show the diff").
- No thanks, no greetings, nothing the message already answered.
- If nothing needs a reply (a finished report with no question, offer or step for the person), return [].
Return only the JSON array.`

const clean = (items: unknown[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const text = item.replace(/\s+/g, ' ').trim()
    const id = text.toLowerCase()
    if (!text || text.length > MAX_LENGTH || seen.has(id)) continue
    seen.add(id)
    out.push(text)
  }
  return out.slice(0, MAX_REPLIES)
}

/** Replies from patterns alone: no model call. */
export const byRules = (answer: string): string[] => {
  const end = answer.slice(-800)
  const out: string[] = []
  if (CONFIRM.test(end)) out.push('Confirm', 'Cancel')
  else if (YES_NO.test(end)) out.push('Yes', 'No')
  if (end.includes('?')) {
    for (const m of end.matchAll(CHOICE)) out.push((m[2] ?? m[3] ?? '').replace(/[*`]/g, '').trim())
  }
  if (HANDS_OFF.test(end)) out.push('Check it for me')
  return clean(out)
}

/** The model's reply, read as a JSON array of strings; null when it is not one. */
export const parseReplies = (text: string): string[] | null => {
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return null
  try {
    const value: unknown = JSON.parse(match[0])
    return Array.isArray(value) ? clean(value) : null
  } catch {
    return null
  }
}

export const isWorthAsking = (answer: string): boolean => {
  const end = answer.slice(-800)
  return ASKS.test(end) || HANDS_OFF.test(end)
}

const byModel = async ($: EngineInterface, answer: string, prompt: string): Promise<string[] | null> => {
  const asked = prompt ? `The person's previous message:\n<person>\n${prompt.slice(-800)}\n</person>\n\n` : ''
  const result = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: `${asked}The assistant's latest message${answer.length > TAIL ? ' (its end)' : ''}:\n<assistant>\n${answer.slice(-TAIL)}\n</assistant>`,
    maxTokens: 150,
    timeoutMs: ASK_TIMEOUT,
  })
  return result.isAnswered ? parseReplies(result.text) : null
}

/** The main loop's newest turn and the prompt it began with; a reload resets them, which is harmless. */
let latestTurn: string | undefined
let latestPrompt = ''
let mode = 'ai'

const suggest = async ($: EngineInterface, turnId: string, answer: string) => {
  if (!answer.trim() || !isWorthAsking(answer)) return
  const replies = mode === 'rules' ? byRules(answer) : ((await byModel($, answer, latestPrompt)) ?? byRules(answer))
  if (replies.length === 0 || (latestTurn !== undefined && latestTurn !== turnId)) return
  await offer($, turnId, replies)
}

/** Adds replies to the ones offered for this turn: ahead of them, or after with `isLast`. */
const offer = ($: EngineInterface, turnId: string, replies: string[], isLast = false) =>
  update($, suggestions, current => {
    const kept = current?.turnId === turnId ? current.replies : []
    return { turnId, replies: clean(isLast ? [...kept, ...replies] : [...replies, ...kept]) }
  })

const send = async ($: EngineInterface, text: string) => {
  await update($, suggestions, () => null)
  await $.prompt.submit({ text, asUser: true })
}

export const register: Register = (on, options) => {
  mode = String(options.mode ?? 'ai')

  on('turn.start', async ($, e, next) => {
    latestTurn = e.turnId
    if (e.text) latestPrompt = e.text
    await update($, suggestions, () => null)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (mode === 'off' || e.agentId !== undefined || e.reason !== 'answer') return result
    const { turnId, answer } = e
    // Off the turn's own dispatch, so its end never waits on the suggestion.
    $.clock.after(0, () => void suggest($, turnId, answer))
    return result
  })

  // Claude Code's own guess at the next prompt (prompt suggestions on) is one more pill, at no cost.
  on('prompt.suggest', async ($, e, next) => {
    const result = await next(e)
    if (mode !== 'off' && e.origin?.kind === 'suggestion' && latestTurn !== undefined) {
      await offer($, latestTurn, [e.text], true)
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    await update($, suggestions, () => null)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) return below
    const offered = await read($, suggestions)
    if (!offered || offered.replies.length === 0) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const row = (
      <Box key="quick-replies" flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1} alignItems="center">
        <Text dimColor>↩ Reply</Text>
        {offered.replies.map((reply, i) => (
          <Button key={`reply-${i}`} label={reply} {...(i === 0 ? { variant: 'primary' as const } : {})} onPress={() => void send($, reply)} />
        ))}
        <Button key="dismiss" label="✕" role="dismiss" plain dimColor onPress={() => void update($, suggestions, () => null)} />
      </Box>
    )
    // Another band (the limits bar) keeps its place above the replies.
    return below.type === 'engine' ? row : (
      <Box flexDirection="column" rowGap={1}>
        {below}
        {row}
      </Box>
    )
  })
}
