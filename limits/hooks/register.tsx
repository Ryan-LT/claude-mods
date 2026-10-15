import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, SessionRateLimit } from 'claude-code'

import type { Context, Limit, Snapshot } from '../types'

const snapshot = atom({ plugin: 'limits', key: 'snapshot' } as const, null)
const now = atom({ plugin: 'limits', key: 'now' } as const, 0)
const alerted = atom({ plugin: 'limits', key: 'alerted' } as const, {})
const refreshing = atom({ plugin: 'limits', key: 'refreshing' } as const, false)
const context = atom({ plugin: 'limits', key: 'context' } as const, null)

const HOUR = 3_600_000
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 168 * HOUR }
const LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: '$' }
const LONG_LABEL: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  spend_limit: 'Spend',
}
const ALERT_AT = [75, 90, 100]
const MINUTE = 60_000
/**
 * Auto refresh runs once per slot of this length, on the clock (:00, :02, :04 …), so its timing is
 * steady; every open session shares one slot, so only one of them asks.
 */
const SLOT = 2 * MINUTE
/** A main-thread turn this old is taken as over, should its end never have been heard. */
const BUSY_MAX = 10 * MINUTE
/** The refresh button's own floor between presses. */
const PRESS_GAP = 30_000
const STORE_LATEST = 'latest'
const STORE_PINGED = 'lastPingAt'
const STORE_SLOT = 'lastSlot'

// ---------- formatting ----------

const fmtTokens = (n: number): string => {
  const short = (v: number, unit: string) => `${Number.isInteger(v) ? v : v.toFixed(1)}${unit}`
  if (n >= 1_000_000) return short(Math.round(n / 100_000) / 10, 'M')
  if (n >= 1_000) return short(Math.round(n / 100) / 10, 'k')
  return String(n)
}

const fmtSpan = (ms: number): string => {
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return mins % 60 ? `${hours}h${mins % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`
}

const fmtPct = (p: number | undefined): string =>
  p === undefined ? '—' : `${p < 10 && p % 1 !== 0 ? p.toFixed(1) : Math.round(p)}%`

const tone = (p: number | undefined): string =>
  p === undefined ? 'inactive' : p >= 85 ? 'error' : p >= 60 ? 'warning' : 'success'

const labelOf = (kind: string): string => LABEL[kind] ?? kind.replace(/_/g, ' ').toUpperCase()
const longLabelOf = (kind: string): string => LONG_LABEL[kind] ?? kind.replace(/_/g, ' ')

const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const sortLimits = (limits: Limit[]): Limit[] =>
  [...limits].sort((a, b) => {
    const ia = ORDER.indexOf(a.kind)
    const ib = ORDER.indexOf(b.kind)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })

/** How far into the window we are versus how much is used, and where that trends. */
const paceOf = (limit: Limit, at: number) => {
  const length = WINDOW_MS[limit.kind]
  if (!length || !limit.resetsAt) return null
  const left = Date.parse(limit.resetsAt) - at
  if (!Number.isFinite(left)) return null
  const elapsed = Math.min(length, Math.max(0, length - left))
  const elapsedPct = (elapsed / length) * 100
  if (elapsed < length * 0.02) return { elapsedPct, delta: 0, runsOutIn: undefined }
  const rate = limit.percentUsed / elapsed // % per ms
  const runsOutIn = rate > 0 && limit.percentUsed < 100 ? (100 - limit.percentUsed) / rate : undefined
  return {
    elapsedPct,
    delta: limit.percentUsed - elapsedPct,
    runsOutIn: runsOutIn !== undefined && runsOutIn < left ? runsOutIn : undefined,
  }
}

// ---------- state ----------

/** `isLive`: the figures came from a response just now, so they stamp `checkedAt`. */
const toSnapshot = (rateLimits: SessionRateLimit[], at: number, isLive = false): Snapshot => ({
  limits: rateLimits.map(r => ({
    kind: r.kind,
    percentUsed: r.percentUsed,
    resetsAt: r.resetsAt,
    ...(isLive ? { checkedAt: at } : {}),
  })),
  at,
})

/** A window whose reset time has passed starts over: show it empty, not stale. */
const current = (l: Limit, at: number): Limit =>
  l.resetsAt && Date.parse(l.resetsAt) <= at ? { kind: l.kind, percentUsed: 0 } : l

const resetMs = (l: Limit) => (l.resetsAt ? Date.parse(l.resetsAt) : 0)

/**
 * Which of two readings of one window is current. The later window wins (its reset is later).
 * Within one window, the latest live reading wins whatever its figure: a plan upgrade drops the
 * percent mid-window. A figure that may be replayed (one a chat saw hours ago) never beats a live
 * one; between two such figures the higher wins, since usage inside a window only climbs.
 */
const newer = (a: Limit, b: Limit): Limit => {
  const gap = resetMs(b) - resetMs(a)
  if (Math.abs(gap) > 30 * MINUTE) return gap > 0 ? b : a
  const keep = (l: Limit) => ({ ...l, resetsAt: l.resetsAt ?? (l === a ? b : a).resetsAt })
  if (a.checkedAt !== undefined || b.checkedAt !== undefined) {
    return (b.checkedAt ?? -1) >= (a.checkedAt ?? -1) ? keep(b) : keep(a)
  }
  return b.percentUsed >= a.percentUsed ? keep(b) : a
}

/**
 * One response may report only some windows (the weekly one, say, and not the 5-hour), so a
 * reading updates the windows it names and keeps the others, unless their reset has passed.
 */
const merge = (prev: Snapshot | null | undefined, next: Snapshot): Snapshot => {
  const byKind = new Map((prev?.limits ?? []).map(l => [l.kind, l]))
  for (const l of next.limits) {
    const had = byKind.get(l.kind)
    byKind.set(l.kind, had ? newer(had, l) : l)
  }
  const limits = [...byKind.values()].filter(
    l => next.limits.some(n => n.kind === l.kind) || !l.resetsAt || Date.parse(l.resetsAt) > next.at,
  )
  return { limits, at: Math.max(prev?.at ?? 0, next.at) }
}

const maybeAlert = async ($: EngineInterface, s: Snapshot) => {
  const seen = await read($, alerted)
  const next: Record<string, number> = { ...seen }
  for (const l of s.limits) {
    const crossed = ALERT_AT.filter(level => l.percentUsed >= level).pop() ?? 0
    if (crossed > (seen[l.kind] ?? 0)) {
      $.ui.toast(`${longLabelOf(l.kind)} limit at ${fmtPct(l.percentUsed)}`, { timeoutMs: 6000 })
    }
    next[l.kind] = crossed
  }
  await update($, alerted, () => next)
}

/** This session's context window: its own, never shared. */
const applyContext = async ($: EngineInterface, c: { tokens?: number; window: number; percent?: number }) => {
  const value: Context = { tokens: c.tokens, window: c.window, percent: c.percent }
  await update($, context, () => value)
}

/** Show a reading here, and hand it to every other open session through the store. */
const apply = async ($: EngineInterface, reading: Snapshot, isShared = true) => {
  if (reading.limits.length === 0) return
  const s = merge(await read($, snapshot), reading)
  await update($, snapshot, () => s)
  await update($, now, () => Date.now())
  await maybeAlert($, s)
  if (isShared) {
    const latest = (await $.store.get(STORE_LATEST)) as Snapshot | undefined
    await $.store.set(STORE_LATEST, merge(latest, reading))
  }
}

/** Takes up a newer reading another session made. */
const pullShared = async ($: EngineInterface) => {
  const latest = (await $.store.get(STORE_LATEST)) as Snapshot | undefined
  const mine = await read($, snapshot)
  if (latest?.limits?.length && (!mine || JSON.stringify(merge(mine, latest).limits) !== JSON.stringify(mine.limits) || mine.at < latest.at)) {
    await apply($, latest, false)
  }
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const WINDOWS = ['five_hour', 'seven_day']

type UsageWindow = { utilization?: number | null; resets_at?: string | null } | null

/**
 * The figures claude.ai's usage page shows, asked of Anthropic with this session's login (the engine
 * sets the credential; the mod never sees it). Null with no claude.ai login: an API key or a gateway.
 */
const fetchUsage = async ($: EngineInterface): Promise<SessionRateLimit[] | null> => {
  const auth = await $.session.authorize()
  if (auth?.kind !== 'bearer') return null
  const res = await $.http.fetch(USAGE_URL, { headers: { 'anthropic-beta': 'oauth-2025-04-20' }, auth: auth.handle })
  if (!res.ok) return null
  const body = JSON.parse(res.text) as Record<string, UsageWindow>
  return WINDOWS.flatMap(kind => {
    const w = body[kind]
    if (typeof w?.utilization !== 'number') return []
    const resetsAt = w.resets_at ? new Date(w.resets_at).toISOString() : undefined
    return [{ kind, percentUsed: Math.round(w.utilization * 10) / 10, ...(resetsAt ? { resetsAt } : {}) }]
  })
}

/**
 * Asks Anthropic for the real figures: no model request, so no tokens, and the slot and press gaps
 * keep it to one ask per two minutes across every open session.
 */
const refresh = async ($: EngineInterface, why: 'press' | 'auto') => {
  if (await read($, refreshing)) return
  const at = await $.clock.now()
  if (why === 'press') {
    const lastPing = Number((await $.store.get(STORE_PINGED)) ?? 0)
    if (at - lastPing < PRESS_GAP) return void (await pullShared($))
  } else {
    // One ask per clock slot across every session: the first to reach the slot takes it.
    const slot = Math.floor(at / SLOT)
    if (Number((await $.store.get(STORE_SLOT)) ?? -1) >= slot) return void (await pullShared($))
    await $.store.set(STORE_SLOT, slot)
  }
  await $.store.set(STORE_PINGED, at)
  await update($, refreshing, () => true)
  try {
    await applyContext($, (await $.session.usage()).context)
    const limits = await fetchUsage($)
    if (limits) await apply($, toSnapshot(limits, await $.clock.now(), true))
  } catch {
    // offline or refused: the last reading stays, with its age on the button
  } finally {
    await update($, refreshing, () => false)
  }
}

/** When the running main-thread turn began, or 0: figures that arrive meanwhile ride on its replies. */
let busySince = 0

const tick = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, now, () => at)
  await pullShared($)
  // Replies bring figures too, but an idle chat can replay old ones: Anthropic's own answer settles it.
  await refresh($, 'auto')
}

/**
 * The 15-second ticker, started by whichever hook runs first in this module's life: a reload
 * in an open chat raises no session.start, and without this the bar would never refresh there.
 */
let isTicking = false

const ensureTicker = ($: EngineInterface) => {
  if (isTicking) return
  isTicking = true
  $.clock.after(50, () => void tick($).catch(() => {}))
  $.clock.every(15_000, () => void tick($).catch(() => {}))
}

// ---------- drawing ----------

/** One limit, reduced to what the band shows. */
type Meter = {
  label: string
  pct: number
  color: string
  reset?: string
  /** Where "now" sits in the window, 0–1: fill past it means ahead of pace. */
  elapsed?: number
  runsOut?: string
  /** Plain grey text after the percent, no icon (the context's token count). */
  detail?: string
  alt: string
}

const HEX: Record<string, string> = {
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
}
// Mid-tone grey reads on both light and dark themes (the surface's theme is not exposed).
const GREY = '#8c959f'
const FONT = 12.5
const CH = FONT * 0.62 // monospace advance; every run is pinned to it with textLength
const BAR_W = 56
const BAR_H = 4
const GAP = 22
const ICON = 11

const toMeter = (raw: Limit, at: number): Meter => {
  const l = current(raw, at)
  const pace = paceOf(l, at)
  const runsOut = pace?.runsOutIn !== undefined ? fmtSpan(pace.runsOutIn) : undefined
  // On track to run out before the reset: the bar and percent go red, no extra text.
  const level = runsOut ? 'error' : tone(l.percentUsed)
  const reset = l.resetsAt ? fmtSpan(Date.parse(l.resetsAt) - at) : undefined
  return {
    label: labelOf(l.kind),
    pct: l.percentUsed,
    color: level,
    reset,
    elapsed: pace ? pace.elapsedPct / 100 : undefined,
    runsOut,
    alt:
      `${longLabelOf(l.kind)} limit ${fmtPct(l.percentUsed)} used` +
      (reset ? `, resets in ${reset}` : '') +
      (pace ? `, ${Math.round(pace.elapsedPct)}% of window elapsed` : '') +
      (runsOut ? `, runs out in about ${runsOut}` : ''),
  }
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** One run of text at x, exactly `text.length * CH` wide whatever font the surface picks. */
const run = (x: number, y: number, text: string, fill: string, bold = false) =>
  `<text x="${x.toFixed(1)}" y="${y}" fill="${fill}"${bold ? ' font-weight="600"' : ''} ` +
  `textLength="${(text.length * CH).toFixed(1)}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>`

/** A small clock: "resets in". */
const clockIcon = (x: number, cy: number, color: string) => {
  const r = ICON / 2 - 0.75
  const cx = x + ICON / 2
  return (
    `<g fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round">` +
    `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${r}"/>` +
    `<path d="M${cx.toFixed(1)} ${cy - r + 2}V${cy}l${(r * 0.55).toFixed(1)} ${(r * 0.45).toFixed(1)}"/></g>`
  )
}

const bandSvg = (meters: Meter[]) => {
  const H = 18
  const y = 13
  const by = (H - BAR_H) / 2
  let x = 0
  let body = ''
  meters.forEach((m, i) => {
    if (i > 0) x += GAP
    const color = HEX[m.color] ?? GREY
    body += run(x, y, m.label, GREY)
    x += m.label.length * CH + 6
    const fill = Math.min(1, Math.max(0, m.pct / 100)) * BAR_W
    body += `<rect x="${x.toFixed(1)}" y="${by}" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${GREY}" fill-opacity=".25"/>`
    if (fill > 0) {
      body += `<rect x="${x.toFixed(1)}" y="${by}" width="${Math.max(BAR_H, fill).toFixed(1)}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>`
    }
    if (m.elapsed !== undefined) {
      const tx = x + Math.min(BAR_W - 1, Math.max(0, m.elapsed * BAR_W))
      body += `<rect x="${tx.toFixed(1)}" y="${by - 2}" width="1" height="${BAR_H + 4}" fill="${GREY}"/>`
    }
    x += BAR_W + 6
    const pct = fmtPct(m.pct)
    body += run(x, y, pct, color, true)
    x += pct.length * CH
    if (m.detail) {
      body += run(x + CH, y, m.detail, GREY)
      x += (m.detail.length + 1) * CH
    }
    if (m.reset) {
      x += 8
      body += clockIcon(x, H / 2, GREY)
      x += ICON + 4
      body += run(x, y, m.reset, GREY)
      x += m.reset.length * CH
    }
  })
  const width = Math.ceil(x + 2)
  return {
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">` +
      `<style>text{font-size:${FONT}px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}</style>${body}</svg>`,
    width,
    height: H,
  }
}

/** Terminal bar: thin line, with a tick at "now" in the window. */
const barRuns = (m: Meter, width = 8): { text: string; color: string }[] => {
  const filled = Math.min(width, Math.max(m.pct > 0 ? 1 : 0, Math.round((m.pct / 100) * width)))
  const tick = m.elapsed === undefined ? -1 : Math.min(width - 1, Math.floor(m.elapsed * width))
  const runs: { text: string; color: string }[] = []
  for (let i = 0; i < width; i++) {
    const [ch, color] = i === tick ? ['┃', 'inactive'] : i < filled ? ['━', m.color] : ['─', 'inactive']
    const prev = runs[runs.length - 1]
    if (prev && prev.color === color && i !== tick && i - 1 !== tick) prev.text += ch
    else runs.push({ text: ch, color })
  }
  return runs
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    $.ui.status(undefined)
    try {
      const usage = await $.session.usage()
      await applyContext($, usage.context)
      await apply($, toSnapshot(usage.rateLimits, Date.now()))
    } catch {
      // usage not available yet; session.measure will fill it in
    }
    await update($, refreshing, () => false)
    ensureTicker($)

    return ran
  })

  on('session.measure', async ($, e, next) => {
    ensureTicker($)
    if (e.changed.includes('context')) await applyContext($, e.context)
    // Mid-turn, the figures ride on the reply that just came in; idle, they may be an old one replayed.
    const isLive = busySince > 0 && Date.now() - busySince < BUSY_MAX
    if (e.changed.includes('rateLimits')) await apply($, toSnapshot(e.rateLimits, Date.now(), isLive))

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    ensureTicker($)
    busySince = Date.now()

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (!e.agentId) busySince = 0

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, alerted, () => ({}))
      await update($, context, () => null)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    ensureTicker($)
    // Another mod's band beneath (quick replies) draws under this one.
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const withBelow = (tree: RenderElement) => {
      if (below.type === 'engine') return tree
      const { Box } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" rowGap={1}>
          {tree}
          {below}
        </Box>
      )
    }

    const s = await read($, snapshot)
    const at = (await read($, now)) || Date.now()
    const ctx = await read($, context)
    const meters = sortLimits(s?.limits ?? []).map(l => toMeter(l, at))
    if (ctx?.percent !== undefined && ctx.tokens !== undefined) {
      const detail = `${fmtTokens(ctx.tokens)}/${fmtTokens(ctx.window)}`
      meters.push({
        label: 'Context',
        pct: ctx.percent,
        color: tone(ctx.percent),
        detail,
        alt: `Context ${detail} tokens, ${fmtPct(ctx.percent)} of the window`,
      })
    }
    const isRefreshing = await read($, refreshing)
    const age = s?.at ? at - s.at : undefined
    const ageText = isRefreshing ? '…' : age === undefined || age < MINUTE ? 'now' : fmtSpan(age)
    type Resolved = typeof $.ui.resolve extends (e: never) => infer T ? T : never
    const refreshButton = (Button: Resolved['Button']) => (
      <Button key="refresh" label={`⟳ ${ageText}`} onPress={() => void refresh($, 'press')} />
    )

    if (e.surface !== 'terminal') {
      const { Box, Button, Svg, Text } = $.ui.resolve(e)
      if (meters.length === 0) return withBelow(<Text dimColor>Limits show after the first reply</Text>)
      const band = bandSvg(meters)
      return withBelow(
        <Box flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={2}>
          <Svg
            source={band.source}
            width={band.width}
            height={band.height}
            alt={meters.map(m => m.alt).join('; ')}
          />
          {refreshButton(Button)}
        </Box>,
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    if (meters.length === 0) return withBelow(<Text dimColor>Limits show after the first reply</Text>)

    return withBelow(
      <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
        {meters.map(m => (
          <Box flexDirection="row">
            <Text dimColor>{m.label} </Text>
            {barRuns(m).map(r => (
              <Text color={r.color}>{r.text}</Text>
            ))}
            <Text color={m.color} bold> {fmtPct(m.pct)}</Text>
            {m.detail ? <Text dimColor> {m.detail}</Text> : null}
            {m.reset ? <Text dimColor> ◷ {m.reset}</Text> : null}
          </Box>
        ))}
        {refreshButton(Button)}
      </Box>,
    )
  })
}
