/** `checkedAt` (ms): when a live response reported it; absent when it may be an old figure replayed. */
export type Limit = { kind: string; percentUsed: number; resetsAt?: string; checkedAt?: number }

/** The limits as one API response reported them, and when (ms). */
export type Snapshot = { limits: Limit[]; at: number }

/** This session's context window, as the last response filled it. */
export type Context = { tokens?: number; window: number; percent?: number }

declare module 'claude-code' {
  interface PluginState {
    'limits': {
      snapshot: Snapshot | null
      now: number
      alerted: Record<string, number>
      refreshing: boolean
      context: Context | null
    }
  }
}
