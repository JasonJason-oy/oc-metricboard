// src/types.ts

export interface RequestMetrics {
  sessionID: string
  messageID: string
  modelID: string
  providerID: string

  // Timing
  requestStartTime: number              // performance.now()
  firstTokenTime: number | null         // Timestamp when first text delta arrives
  lastDeltaTime: number | null          // Last delta arrival time
  completeTime: number | null           // Idle timestamp

  // Token counts
  estimatedInputTokens: number          // Estimated from user message content length / ratio
  estimatedOutputTokens: number         // Accumulated from delta.length / ratio
  exactInputTokens: number              // From AssistantMessage.tokens
  exactOutputTokens: number
  exactCacheReadTokens: number
  exactCacheWriteTokens: number
  exactReasoningTokens: number
  hasExactTokens: boolean               // Whether exact values have been received
  hasExactCacheReadTokens: boolean
  hasExactCacheWriteTokens: boolean

  // State
  isStreaming: boolean                  // Whether still streaming
  isComplete: boolean                   // Whether request is complete (idle)
}

export interface FinalizedStepUsage {
  outputTokens: number
  exact: boolean
}

export interface TurnMetrics {
  sessionID: string
  turnStartTime: number
  firstTokenTime: number | null        // First token of the turn (user message → first delta)
  completeTime: number | null
  finalizedOutputTokens: number
  finalizedSteps: Map<string, FinalizedStepUsage>
  stickyContextTokens: number
  stickyContextUpdatedAt: number
  hasStickyContextTokens: boolean
  stickyCacheReadTokens: number
  hasStickyCacheReadTokens: boolean
  isComplete: boolean
}

export interface LiveSpeedSample {
  at: number
  cumulativeTokens: number
}

export interface LiveSpeedState {
  messageID: string
  cumulativeTokens: number
  samples: LiveSpeedSample[]
}

export type MetricsScope = "current" | "tree"

export type CacheReadCompleteness = "exact" | "partial" | "unknown"

export interface ModelMetrics {
  modelID: string
  providerID: string
  sessionID: string
  // Number of sub-agent sessions sharing this (provider, model) — used for the
  // "×N" count in the model-grouped breakdown.
  sessionCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheReadCompleteness: CacheReadCompleteness
  requestStartTime: number
  firstTokenTime: number | null
  completeTime: number | null
  ttft: number | null
  liveTps: number | null
  isStreaming: boolean
  isComplete: boolean
}

export interface MetricsAggregate {
  sessionIDs: string[]
  childSessionCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheReadCompleteness: CacheReadCompleteness
  requestStartTime: number
  firstTokenTime: number | null
  completeTime: number | null
  ttft: number | null
  liveTps: number | null
  isStreaming: boolean
  isComplete: boolean
  // NEW: per-model breakdown for tree scope
  modelBreakdown: ModelMetrics[]
}

export interface BarConfig {
  refreshIntervalMs: number
  holdDurationMs: number
  estimationRatio: number
  enableLogging: boolean
  visible: {
    speed: boolean
    ttft: boolean
    input: boolean
    output: boolean
    cache: boolean
    elapsed: boolean
    session: boolean
    model: boolean
    modelBreakdown: boolean
  }
}

export const DEFAULT_CONFIG: BarConfig = {
  refreshIntervalMs: 200,
  holdDurationMs: 0,
  estimationRatio: 4.0,
  enableLogging: false,
  visible: {
    speed: true,
    ttft: true,
    input: true,
    output: true,
    cache: false,
    elapsed: true,
    session: true,
    model: true,
    modelBreakdown: true,
  },
}