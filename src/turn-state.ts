import { getDisplayInputTokens, getDisplayOutputTokens } from "./metrics"
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
