/** The replies offered for one finished turn. */
export type Suggestions = { turnId: string; replies: string[] }

declare module 'claude-code' {
  interface PluginState {
    'quick-replies': { suggestions: Suggestions | null }
  }
}
