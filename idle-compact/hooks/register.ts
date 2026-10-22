import type { EngineInterface, Register } from 'claude-code'

const MINUTE = 60_000
/**
 * Quiet this long after the last reply: compact before the prompt cache (1 hour) goes cold, and
 * before the desktop app disconnects an idle chat (30 minutes), which ends this process and its timer.
 */
const IDLE = 25 * MINUTE
/** A smaller chat is cheap to come back to as it is. */
const MIN_TOKENS = 150_000
const CHECK_EVERY = MINUTE
const KEEP =
  'Keep what was asked last and any open tasks, decisions and why they were made, exact file paths, links, ' +
  'commands, and error messages, so the work can resume without re-explaining.'

/**
 * When this process last saw a main-thread reply end, or 0. Zero until a reply in this process,
 * so a chat reopened cold (cache already gone) is never compacted: that would pay full price.
 */
let lastReplyAt = 0
let isBusy = false
let isCompacting = false
let isTicking = false
/** The /compact we start runs as a turn of its own here; its end is not a reply to arm on. */
let isOwnTurnNext = false

const check = async ($: EngineInterface) => {
  if (!lastReplyAt || isBusy || isCompacting) return
  if ((await $.clock.now()) - lastReplyAt < IDLE) return
  // One try per idle stretch: the next reply arms it again.
  lastReplyAt = 0
  const { context } = await $.session.usage()
  if ((context.tokens ?? 0) < MIN_TOKENS) return
  isCompacting = true
  try {
    isOwnTurnNext = true
    // In the desktop app and SDK, compaction runs as a /compact turn, not a direct call.
    await $.session.compact({ instructions: KEEP }).catch(() => $.command.run({ command: 'compact', args: KEEP }))
  } catch {
    isOwnTurnNext = false
    // A turn started meanwhile, or compaction isn't possible now: leave the chat as it is.
  } finally {
    isCompacting = false
  }
}

const ensureTicker = ($: EngineInterface) => {
  if (isTicking) return
  isTicking = true
  $.clock.every(CHECK_EVERY, () => void check($).catch(() => {}))
}

export const register: Register = on => {
  on('turn.start', ($, e, next) => {
    ensureTicker($)
    isBusy = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      isBusy = false
      if (isOwnTurnNext) {
        isOwnTurnNext = false
        return done
      }
      lastReplyAt = await $.clock.now()
      ensureTicker($)
    }

    return done
  })
}
