import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const suggestions = atom({ plugin: 'quick-replies', key: 'suggestions' } as const, null)

const MAX_REPLIES = 4
const MAX_LENGTH = 40
const MAX_DECISIONS = 4
/** Replies under one decision: its own row has less room. */
const MAX_PER_DECISION = 3
const MAX_TOPIC = 24
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
/** A numbered line that is itself a question: one decision of several. */
const QUESTION_ITEM = /^\s*\d[.)]\s+(.+\?)\s*$/gm
/** The ask around a question, dropped to leave its subject. */
const ASK_WORDS =
  /^(?:(?:should|shall|can|could) i|(?:do you )?want me to|would you like (?:me )?to|do you want|ok to|okay to|also|and|then|to)\s+/i

const SYSTEM = `You write the quick-reply buttons of a chat app where a person works with an AI coding assistant.
Given the assistant's latest message, return the replies the person is most likely to send next, best first, as a JSON array of strings.
- At most ${MAX_REPLIES} replies, each 1 to 5 words, written as the person would type it, in the language the person writes in.
- Answer what the message asks. A yes/no or confirm question: "Yes" / "No" (or "Confirm" / "Cancel"). An offer to do something: "Yes, do it", "Not now". Named choices or numbered options: the choices themselves, short.
- If the message tells the person to run, check, open, restart or verify something themselves, include "Check it for me" (or "Do it for me" when it is an action).
- A useful follow-up is fine when the message clearly invites one (for example "Commit it", "Show the diff").
- No thanks, no greetings, nothing the message already answered.
- If nothing needs a reply (a finished report with no question, offer or step for the person), return [].
Several separate decisions: when the message asks about two or more independent things (numbered questions, several offers), return an object instead:
{"decisions":[{"topic":"README","replies":["Yes","No"]},{"topic":"Release","replies":["Patch","Minor"]}],"combined":["Do all","Only README","Skip all"]}
- One decision per thing asked, in the message's order, at most ${MAX_DECISIONS}. "topic" names it in 1 to 3 words; "replies" are 2 or 3 answers to that one thing.
- "combined" answers several at once, best first, at most 3: "Do all" / "Skip all", or the likely mix ("Only README", "1 and 3").
Return only the JSON.`

type Decision = { topic: string; replies: string[] }
/** What one reply offers: the pills, and its separate decisions when it asks several things. */
export type Offer = { replies: string[]; decisions?: Decision[] }

const clean = (items: unknown[], max = MAX_REPLIES): string[] => {
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
  return out.slice(0, max)
}

const cleanDecisions = (items: unknown[]): Decision[] =>
  items
    .flatMap(item => {
      if (typeof item !== 'object' || item === null) return []
      const { topic, replies } = item as { topic?: unknown; replies?: unknown }
      const name = typeof topic === 'string' ? topic.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim() : ''
      const answers = Array.isArray(replies) ? clean(replies, MAX_PER_DECISION) : []
      return name && name.length <= MAX_TOPIC && answers.length > 0 ? [{ topic: name, replies: answers }] : []
    })
    .slice(0, MAX_DECISIONS)

/** A question's subject in a few words: `Should I also update the README?` → `update the README`; a bold lead names it. */
export const topicOf = (question: string): string => {
  const named = question.match(/^\*\*([^*]{1,24})\*\*/)?.[1]?.replace(/[:.]$/, '').trim()
  if (named) return named
  let text = question.replace(/[*`?]/g, '').trim()
  for (let prev = ''; prev !== text; ) {
    prev = text
    text = text.replace(ASK_WORDS, '')
  }
  const words = text.split(/\s+/).slice(0, 4)
  while (words.length > 1 && words.join(' ').length > MAX_TOPIC) words.pop()
  return words.join(' ').slice(0, MAX_TOPIC)
}

/** Replies from patterns alone: no model call. */
export const byRules = (answer: string): Offer => {
  const questions = [...answer.slice(-TAIL).matchAll(QUESTION_ITEM)].map(m => topicOf(m[1] ?? ''))
  if (questions.length >= 2) {
    const decisions = cleanDecisions(questions.map(topic => ({ topic, replies: ['Yes', 'No'] })))
    if (decisions.length >= 2) return { replies: ['Yes to all', 'No to all'], decisions }
  }
  const end = answer.slice(-800)
  const out: string[] = []
  if (CONFIRM.test(end)) out.push('Confirm', 'Cancel')
  else if (YES_NO.test(end)) out.push('Yes', 'No')
  if (end.includes('?')) {
    for (const m of end.matchAll(CHOICE)) out.push((m[2] ?? m[3] ?? '').replace(/[*`]/g, '').trim())
  }
  if (HANDS_OFF.test(end)) out.push('Check it for me')
  return { replies: clean(out) }
}

const parseJson = (text: string | undefined): unknown => {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The model's reply: a JSON array of replies, or an object of decisions; null
 * when it is neither. One decision alone is just its replies.
 */
export const parseReplies = (text: string): Offer | null => {
  const object = parseJson(text.match(/\{[\s\S]*\}/)?.[0])
  if (typeof object === 'object' && object !== null && 'decisions' in object) {
    const { decisions, combined } = object as { decisions?: unknown; combined?: unknown }
    const found = Array.isArray(decisions) ? cleanDecisions(decisions) : []
    const together = Array.isArray(combined) ? clean(combined, 3) : []
    if (found.length >= 2) return { replies: together, decisions: found }
    if (found.length === 1) return { replies: found[0]!.replies }
  }
  const list = parseJson(text.match(/\[[\s\S]*\]/)?.[0])
  return Array.isArray(list) ? { replies: clean(list) } : null
}

export const isWorthAsking = (answer: string): boolean => {
  const end = answer.slice(-800)
  return ASKS.test(end) || HANDS_OFF.test(end)
}

const byModel = async ($: EngineInterface, answer: string, prompt: string): Promise<Offer | null> => {
  const asked = prompt ? `The person's previous message:\n<person>\n${prompt.slice(-800)}\n</person>\n\n` : ''
  const result = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: `${asked}The assistant's latest message${answer.length > TAIL ? ' (its end)' : ''}:\n<assistant>\n${answer.slice(-TAIL)}\n</assistant>`,
    maxTokens: 300,
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
  const found = mode === 'rules' ? byRules(answer) : ((await byModel($, answer, latestPrompt)) ?? byRules(answer))
  if ((found.replies.length === 0 && !found.decisions) || (latestTurn !== undefined && latestTurn !== turnId)) return
  await offer($, turnId, found)
}

/** Adds replies to the ones offered for this turn: ahead of them, or after with `isLast`. */
const offer = ($: EngineInterface, turnId: string, found: Offer, isLast = false) =>
  update($, suggestions, current => {
    const same = current?.turnId === turnId ? current : null
    const kept = same?.replies ?? []
    const decisions = found.decisions ?? same?.decisions
    return {
      turnId,
      replies: clean(isLast ? [...kept, ...found.replies] : [...found.replies, ...kept]),
      ...(decisions ? { decisions, picks: found.decisions ? decisions.map(() => -1) : (same?.picks ?? decisions.map(() => -1)) } : {}),
    }
  })

/** Picks reply `j` of decision `i`, or takes the pick back when it is the one picked. */
const pick = ($: EngineInterface, i: number, j: number) =>
  update($, suggestions, current => {
    if (!current?.picks) return current
    const picks = current.picks.map((p, k) => (k === i ? (p === j ? -1 : j) : p))
    return { ...current, picks }
  })

/** The picked answers as one message: a line per decision answered. */
export const composed = (decisions: Decision[], picks: number[]): string =>
  decisions
    .flatMap((d, i) => {
      const reply = d.replies[picks[i] ?? -1]
      return reply ? [`${d.topic}: ${reply}`] : []
    })
    .join('\n')

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
      await offer($, latestTurn, { replies: [e.text] }, true)
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
    const { decisions, picks = [] } = offered
    const picked = picks.filter(p => p >= 0).length
    const dismiss = (
      <Button key="dismiss" label="✕" role="dismiss" plain dimColor onPress={() => void update($, suggestions, () => null)} />
    )
    const head = (
      <Box key="quick-replies" flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1} alignItems="center">
        <Text dimColor>↩ Reply</Text>
        {offered.replies.map((reply, i) => (
          <Button
            key={`reply-${i}`}
            label={reply}
            {...(i === 0 && !decisions ? { variant: 'primary' as const } : {})}
            onPress={() => void send($, reply)}
          />
        ))}
        {decisions && picked > 0 ? (
          <Button
            key="send"
            label={`Send ${picked} ${picked === 1 ? 'answer' : 'answers'}`}
            variant="primary"
            onPress={() => void send($, composed(decisions, picks))}
          />
        ) : null}
        {dismiss}
      </Box>
    )
    // Several decisions: a row each, a pill per answer; picks add up to one message.
    const labelWidth = decisions ? Math.max(...decisions.map(d => d.topic.length)) + 4 : 0
    const row = !decisions ? head : (
      <Box key="quick-replies-decisions" flexDirection="column" rowGap={1}>
        {head}
        {decisions.map((d, i) => (
          <Box key={`decision-${i}`} flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1} alignItems="center">
            <Box minWidth={labelWidth}>
              <Text dimColor>{`${i + 1}. ${d.topic}`}</Text>
            </Box>
            {d.replies.map((reply, j) => (
              <Button
                key={`pick-${i}-${j}`}
                label={picks[i] === j ? `✓ ${reply}` : reply}
                {...(picks[i] === j ? { variant: 'primary' as const } : {})}
                onPress={() => void pick($, i, j)}
              />
            ))}
          </Box>
        ))}
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
