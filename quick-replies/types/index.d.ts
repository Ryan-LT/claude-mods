export type Decision = { topic: string; replies: string[] }
/** The replies offered for one finished turn: `decisions` when one reply asks several things; `picks` the answer index per decision, -1 for none yet; `answer` the reply's end, to find the block they go under. */
export type Suggestions = { turnId: string; replies: string[]; decisions?: Decision[]; picks?: number[]; answer?: string }

declare module 'claude-code' {
  interface PluginState {
    'quick-replies': { suggestions: Suggestions | null }
  }
}
