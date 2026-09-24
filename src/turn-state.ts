import { gateTtft, getDisplayInputTokens, getDisplayOutputTokens } from "./metrics"
import type { RequestMetrics, TurnMetrics } from "./types"

export function createTurnMetrics(sessionID: string, now: number): TurnMetrics {
  return {
    sessionID,
    turnStartTime: now,
    firstTokenTime: null,
    completeTime: null,
    finalizedOutputTokens: 0,
    finalizedSteps: new Map(),
    stickyContextTokens: 0,
    stickyContextUpdatedAt: Number.NEGATIVE_INFINITY,
    hasStickyContextTokens: false,
    stickyCacheReadTokens: 0,
    hasStickyCacheReadTokens: false,
    toolIntervals: [],
    isComplete: false,
  }
}

export function ensureTurn(
  turns: Map<string, TurnMetrics>,
  sessionID: string,
  now: number,
): TurnMetrics {
  const existing = turns.get(sessionID)
  if (existing) return existing
  const turn = createTurnMetrics(sessionID, now)
  turns.set(sessionID, turn)
  return turn
}

export function startTurn(
  turns: Map<string, TurnMetrics>,
  sessionID: string,
  now: number,
): TurnMetrics {
  const turn = createTurnMetrics(sessionID, now)
  turns.set(sessionID, turn)
  return turn
}

export function retireRequestIntoTurn(
  turn: TurnMetrics,
  request: RequestMetrics,
  updateSticky = true,
): boolean {
  if (!request.messageID) return false
  const outputTokens = getDisplayOutputTokens(request)
  const exact = request.hasExactTokens
  const previous = turn.finalizedSteps.get(request.messageID)

  if (!previous) {
    turn.finalizedSteps.set(request.messageID, { outputTokens, exact })
    turn.finalizedOutputTokens += outputTokens
  } else if (!previous.exact && exact) {
    turn.finalizedOutputTokens += outputTokens - previous.outputTokens
    turn.finalizedSteps.set(request.messageID, { outputTokens, exact: true })
  } else {
    return false
  }

  if (updateSticky && exact && request.requestStartTime >= turn.stickyContextUpdatedAt) {
    turn.stickyContextTokens = getDisplayInputTokens(request)
    turn.stickyContextUpdatedAt = request.requestStartTime
    turn.hasStickyContextTokens = true
    turn.stickyCacheReadTokens = Math.max(0, request.exactCacheReadTokens)
    turn.hasStickyCacheReadTokens = request.hasExactCacheReadTokens
  }
  return true
}

export function liveRequestOutput(turn: TurnMetrics, request: RequestMetrics | undefined): number {
  if (!request?.messageID || turn.finalizedSteps.has(request.messageID)) return 0
  return getDisplayOutputTokens(request)
}

export function turnInputTokens(turn: TurnMetrics, request: RequestMetrics | undefined): number {
  if (turn.hasStickyContextTokens) return turn.stickyContextTokens
  return request ? getDisplayInputTokens(request) : 0
}

export function completeTurn(turn: TurnMetrics, now: number): void {
  turn.isComplete = true
  turn.completeTime = now
}

/**
 * Record the turn's first token instant (once). opencode stamps step.started
 * at the first token, so intra-turn steps cannot measure their own request
 * start; the turn-level anchor (user message → first delta) is the only
 * meaningful TTFT observable from the event stream.
 */
export function recordTurnFirstToken(turn: TurnMetrics, now: number): void {
  if (turn.firstTokenTime === null) turn.firstTokenTime = now
}

/**
 * Record a tool execution span on the session's turn. Tools in one turn may
 * overlap (parallel calls), so every span is kept and the union is computed
 * at query time — a plain sum would double-count overlaps.
 */
export function recordToolCalled(
  turns: Map<string, TurnMetrics>,
  sessionID: string,
  toolID: string,
  now: number,
): void {
  const turn = ensureTurn(turns, sessionID, now)
  turn.toolIntervals.push({ id: toolID, start: now, end: null })
}

export function recordToolSettled(
  turns: Map<string, TurnMetrics>,
  sessionID: string,
  toolID: string,
  now: number,
): void {
  const turn = turns.get(sessionID)
  if (!turn) return
  if (toolID) {
    const open = turn.toolIntervals.find((interval) => interval.id === toolID && interval.end === null)
    if (open) {
      open.end = Math.max(now, open.start)
      return
    }
  }
  // Unknown id (or unsettled shape): close the most recent open span so a
  // lost settle event cannot leak an infinite interval.
  for (let i = turn.toolIntervals.length - 1; i >= 0; i--) {
    if (turn.toolIntervals[i]!.end === null) {
      turn.toolIntervals[i]!.end = Math.max(now, turn.toolIntervals[i]!.start)
      return
    }
  }
}

/**
 * Milliseconds of tool execution overlapping [from, to], unioned so parallel
 * tool calls count once. Open spans are clamped at `to`.
 */
export function toolOverlapMs(turn: TurnMetrics | undefined, from: number, to: number): number {
  if (!turn || to <= from) return 0
  const spans: Array<{ start: number; end: number }> = []
  for (const interval of turn.toolIntervals) {
    const start = Math.max(interval.start, from)
    const end = Math.min(interval.end ?? to, to)
    if (end > start) spans.push({ start, end })
  }
  spans.sort((a, b) => a.start - b.start)
  let total = 0
  let cursor: number | null = null
  let cursorEnd = 0
  for (const span of spans) {
    if (cursor === null || span.start > cursorEnd) {
      if (cursor !== null) total += cursorEnd - cursor
      cursor = span.start
      cursorEnd = span.end
    } else if (span.end > cursorEnd) {
      cursorEnd = span.end
    }
  }
  if (cursor !== null) total += cursorEnd - cursor
  return total
}

/**
 * Turn-level TTFT (user message → first token), gated. Falls back to the
 * supplied per-request TTFT when the turn has no first-token timing. This is
 * the ONLY meaningful TTFT observable from opencode's event stream for
 * intra-turn steps, so every TTFT display path should prefer it.
 */
export function getTurnTtft(turn: TurnMetrics | undefined, fallback: number | null = null): number | null {
  if (turn?.firstTokenTime != null) {
    const gated = gateTtft(turn.firstTokenTime - turn.turnStartTime)
    if (gated !== null) return gated
  }
  return fallback
}
