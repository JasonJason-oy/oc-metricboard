import type { LiveSpeedState } from "./types"

export const LIVE_SPEED_WINDOW_MS = 3000
export const LIVE_SPEED_STALE_MS = 2000
export const LIVE_SPEED_MAX_SAMPLES = 256
// Minimum interval between distinct samples. History replay during session
// reopen delivers many deltas in a few milliseconds; merging those into one
// sample prevents the rolling window from reporting absurd TPS values.
export const LIVE_SPEED_MIN_SAMPLE_INTERVAL_MS = 20

export function resetLiveSpeed(
  states: Map<string, LiveSpeedState>,
  sessionID: string,
  messageID: string,
): void {
  states.set(sessionID, {
    messageID,
    cumulativeTokens: 0,
    samples: [],
  })
}

export function clearLiveSpeed(states: Map<string, LiveSpeedState>, sessionID: string): void {
  states.delete(sessionID)
}

export function recordLiveTokens(
  states: Map<string, LiveSpeedState>,
  sessionID: string,
  messageID: string,
  deltaTokens: number,
  now: number,
): void {
  if (!Number.isFinite(deltaTokens) || deltaTokens <= 0) return

  let state = states.get(sessionID)
  if (!state || state.messageID !== messageID) {
    state = { messageID, cumulativeTokens: 0, samples: [] }
    states.set(sessionID, state)
  }

  state.cumulativeTokens += deltaTokens

  // Merge into the most recent sample when deltas arrive faster than the
  // minimum interval (e.g. history replay bursts). This keeps the windowed
  // TPS honest without discarding the token counts themselves.
  const latest = state.samples.at(-1)
  if (latest !== undefined && now - latest.at < LIVE_SPEED_MIN_SAMPLE_INTERVAL_MS) {
    latest.cumulativeTokens = state.cumulativeTokens
  } else {
    state.samples.push({ at: now, cumulativeTokens: state.cumulativeTokens })
  }

  const cutoff = now - LIVE_SPEED_WINDOW_MS
  while (state.samples.length > 2 && state.samples[1]!.at < cutoff) {
    state.samples.shift()
  }
  while (state.samples.length > LIVE_SPEED_MAX_SAMPLES) state.samples.shift()
}

export function getLiveTps(state: LiveSpeedState | undefined, now: number): number | null {
  if (!state || state.samples.length < 2) return null
  const latest = state.samples.at(-1)!
  if (now - latest.at >= LIVE_SPEED_STALE_MS) return null

  const cutoff = latest.at - LIVE_SPEED_WINDOW_MS
  let baseline = state.samples[0]!
  for (const sample of state.samples) {
    if (sample.at >= cutoff) {
      baseline = sample
      break
    }
  }

  const elapsedMs = latest.at - baseline.at
  const tokens = latest.cumulativeTokens - baseline.cumulativeTokens
  if (elapsedMs <= 0 || tokens <= 0) return null
  return Math.round((tokens / (elapsedMs / 1000)) * 10) / 10
}
