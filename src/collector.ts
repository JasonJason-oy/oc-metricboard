import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BarConfig, CacheReadCompleteness, MetricsAggregate, MetricsScope, ModelMetrics, RequestMetrics } from "./types"
import { getDisplayInputTokens, getDisplayOutputTokens, getTtft } from "./metrics"
import { registerEventHandlers } from "./event-handlers"
import type { CollectorState } from "./collector-state"
import type { MetricsEventApi } from "./event-bus"
import { hydrateSession, isHydrationApi, callWithFallback, type HydrationApi } from "./session-hydration"
import { createSessionTree } from "./session-tree"
import { getScopeElapsedMs, getSessionElapsedMs, startSessionTiming, stopSessionTiming } from "./session-timing"
import { clearLiveSpeed, getLiveTps } from "./live-speed"
import { getTurnTtft, liveRequestOutput, turnInputTokens } from "./turn-state"

export type MetricsListener = () => void
type MetricsHydrationApi = MetricsEventApi & HydrationApi

interface TreeHydrationApi {
  readonly client: {
    readonly session: {
      children(options: { path?: { sessionID?: string; id?: string }; sessionID?: string }): Promise<unknown>
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTreeHydrationApi(value: unknown): value is TreeHydrationApi {
  if (!isRecord(value) || !isRecord(value.client)) return false
  const session = isRecord(value.client.session) ? value.client.session : null
  return session !== null && typeof session.children === "function"
}

function childSessions(value: unknown): Array<{ id: string; parentID: string | null }> {
  if (isRecord(value) && value.error !== undefined && value.error !== null) {
    throw new Error(`session.children returned an error: ${String(value.error)}`)
  }
  const data = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.data) ? value.data : []
  return data.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) return []
    return [{ id: item.id, parentID: typeof item.parentID === "string" ? item.parentID : null }]
  })
}

export interface MetricsCollector {
  getCurrent(sessionID: string): RequestMetrics | null
  getAggregate(sessionID: string, scope: MetricsScope, now?: number): MetricsAggregate | null
  getSessionElapsedMs(sessionID: string, scope?: MetricsScope, now?: number): number
  getChildSessionCount(sessionID: string): number
  subscribe(listener: MetricsListener): () => void
  dispose(): void
}

export function createCollector(
  api: TuiPluginApi,
  config: BarConfig,
  log: (msg: string) => void,
): MetricsCollector
export function createCollector(
  api: MetricsEventApi,
  config: BarConfig,
  log: (msg: string) => void,
): MetricsCollector
export function createCollector(
  api: MetricsHydrationApi,
  config: BarConfig,
  log: (msg: string) => void,
): MetricsCollector
export function createCollector(
  api: TuiPluginApi | MetricsEventApi | MetricsHydrationApi,
  config: BarConfig,
  log: (msg: string) => void,
): MetricsCollector {
  const state: CollectorState = {
    requests: new Map(),
    turns: new Map(),
    liveSpeeds: new Map(),
    holdTimers: new Map(),
    sessionTree: createSessionTree(),
    sessionModels: new Map(),
    sessionTimings: new Map(),
    userMessageIds: new Map(),
    assistantMessageIds: new Map(),
    partTokenEstimates: new Map(),
    sessionAliases: new Map(),
    seenEventKeys: new Set(),
    seenEventOrder: [],
    lastRequestSessionID: null,
  }
  const listeners = new Set<MetricsListener>()
  const hydrationApi = isHydrationApi(api) ? api : null
  const treeHydrationApi = isTreeHydrationApi(api) ? api : null
  const hydratedSessions = new Set<string>()
  const hydratingSessions = new Set<string>()
  const hydrationRetryAfter = new Map<string, number>()
  // Cap hydration attempts per session: a session with no positive-token
  // history will never succeed, and retrying every 2s on every render tick
  // would fire SDK network requests indefinitely. Give up after N attempts.
  const hydrationRetries = new Map<string, number>()
  const MAX_HYDRATION_RETRIES = 5
  const loggedFallbacks = new Set<string>()
  const hydratedTreeRoots = new Set<string>()
  const hydratingTreeRoots = new Set<string>()
  const treeRetryAfter = new Map<string, number>()
  let disposed = false

  // Short-TTL aggregate cache: SidebarMetrics calls getAggregate once per row
  // (~10 rows) per 200ms tick, and each call traverses the whole session tree.
  // Reusing the result within one tick avoids redundant O(tree) work.
  const AGGREGATE_CACHE_TTL_MS = 150
  let aggregateCacheKey = ""
  let aggregateCacheAt = 0
  let aggregateCacheValue: MetricsAggregate | null = null

  function notify(): void {
    if (disposed) return
    // Invalidate the aggregate cache: events mean state changed.
    aggregateCacheKey = ""
    aggregateCacheAt = 0
    aggregateCacheValue = null
    for (const listener of listeners) listener()
  }

  function clearHoldTimer(sessionID: string): void {
    const timer = state.holdTimers.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      state.holdTimers.delete(sessionID)
    }
  }

  const disposers = registerEventHandlers({
    api,
    config,
    log,
    state,
    actions: {
      notify,
      startSessionTiming: (sessionID, now) => startSessionTiming(state.sessionTimings, sessionID, now),
      stopSessionTiming: (sessionID, now) => stopSessionTiming(state.sessionTimings, sessionID, now),
      clearHoldTimer,
    },
  })

  function hydrate(sessionID: string): void {
    if (!hydrationApi || hydratedSessions.has(sessionID) || hydratingSessions.has(sessionID)) return
    const now = performance.now()
    if ((hydrationRetryAfter.get(sessionID) ?? 0) > now) return
    if ((hydrationRetries.get(sessionID) ?? 0) >= MAX_HYDRATION_RETRIES) return
    hydratingSessions.add(sessionID)

    // Hydration is async (SDK client calls). Kick it off fire-and-forget;
    // completion re-renders the UI via notify().
    void (async () => {
      let hydrated = false
      try {
        hydrated = await hydrateSession({ api: hydrationApi, state, sessionID, now })
      } catch (error) {
        log(`session hydration failed: session=${sessionID} error=${String(error)}`)
      } finally {
        hydratingSessions.delete(sessionID)
      }
      if (disposed) return
      const current = state.requests.get(sessionID)
      if (hydrated && current) {
        hydratedSessions.add(sessionID)
        hydrationRetryAfter.delete(sessionID)
        hydrationRetries.delete(sessionID)
        // Drop live-speed samples: reopening a session replays history deltas
        // in a burst, which would inflate the rolling TPS window to absurd
        // values. Historical token counts are restored via exact tokens, so
        // replay-produced samples are garbage and must be discarded.
        clearLiveSpeed(state.liveSpeeds, sessionID)
        log(`hydrated session state: session=${sessionID} message=${current.messageID} in=${current.exactInputTokens} out=${current.exactOutputTokens}`)
        notify()
      } else {
        hydrationRetryAfter.set(sessionID, now + 2000)
        hydrationRetries.set(sessionID, (hydrationRetries.get(sessionID) ?? 0) + 1)
      }
    })()
  }

  function hydrateTree(rootSessionID: string): void {
    if (!treeHydrationApi || hydratedTreeRoots.has(rootSessionID) || hydratingTreeRoots.has(rootSessionID)) return
    const now = performance.now()
    if ((treeRetryAfter.get(rootSessionID) ?? 0) > now) return
    hydratingTreeRoots.add(rootSessionID)

    void (async () => {
      try {
        let parents = [rootSessionID]
        const visited = new Set<string>(parents)
        while (parents.length > 0) {
          const responses = await Promise.all(parents.map(async (parentID) => ({
            parentID,
            response: await callWithFallback([
              () => treeHydrationApi.client.session.children({ path: { sessionID: parentID } }),
              () => treeHydrationApi.client.session.children({ path: { id: parentID } }),
              () => treeHydrationApi.client.session.children({ sessionID: parentID }),
            ]),
          })))
          if (disposed) return
          const next: string[] = []
          for (const { parentID, response } of responses) {
            for (const child of childSessions(response)) {
              const childID = child.id
              state.sessionTree.setParent(childID, child.parentID ?? parentID)
              hydrate(childID)
              if (!visited.has(childID)) {
                visited.add(childID)
                next.push(childID)
              }
            }
          }
          parents = next
        }
        hydratedTreeRoots.add(rootSessionID)
        treeRetryAfter.delete(rootSessionID)
        notify()
      } catch (error) {
        if (!disposed) {
          treeRetryAfter.set(rootSessionID, performance.now() + 2000)
          log(`tree hydration failed: session=${rootSessionID} error=${String(error)}`)
        }
      } finally {
        hydratingTreeRoots.delete(rootSessionID)
      }
    })()
  }

  function normalizeSessionID(sessionID: string): string {
    return typeof sessionID === "string" ? sessionID : ""
  }

  function hasUsefulMetrics(metrics: readonly RequestMetrics[]): boolean {
    return metrics.some((item) => (
      getDisplayInputTokens(item) > 0
      || getDisplayOutputTokens(item) > 0
      || item.exactCacheReadTokens > 0
      || item.exactCacheWriteTokens > 0
      || item.firstTokenTime !== null
      || item.lastDeltaTime !== null
    ))
  }

  function hasUsefulSession(sessionID: string): boolean {
    const request = state.requests.get(sessionID)
    const turn = state.turns.get(sessionID)
    return Boolean(
      (request && hasUsefulMetrics([request]))
      || (turn && (
        turn.finalizedOutputTokens > 0
        || turn.hasStickyContextTokens
      )),
    )
  }

  function usefulMetricsFor(ids: readonly string[]): readonly RequestMetrics[] {
    const metrics = ids
      .map((id) => state.requests.get(id))
      .filter((item): item is RequestMetrics => item !== undefined)
    return metrics.length > 0 && ids.some(hasUsefulSession) ? metrics : []
  }

  function aliasScopeSessionIDs(sessionID: string, scope: MetricsScope): { readonly rootID: string; readonly ids: readonly string[] } | null {
    for (const aliasID of state.sessionAliases.get(sessionID) ?? []) {
      const aliasIDs = state.sessionTree.getScopeSessionIDs(aliasID, scope)
      if (usefulMetricsFor(aliasIDs).length > 0) {
        return { rootID: aliasID, ids: aliasIDs }
      }
    }
    return null
  }

  function resolveMetricsSessionID(sessionID: string): string {
    const requestedSessionID = normalizeSessionID(sessionID)
    const requested = state.requests.get(requestedSessionID)
    if ((requested && hasUsefulMetrics([requested])) || hasUsefulSession(requestedSessionID)) return requestedSessionID
    const alias = aliasScopeSessionIDs(requestedSessionID, "current")
    if (alias) return alias.rootID
    return requestedSessionID
  }

  function scopeSessionIDs(sessionID: string, scope: MetricsScope): { readonly rootID: string; readonly ids: readonly string[] } {
    const requestedSessionID = normalizeSessionID(sessionID)
    const requestedIDs = state.sessionTree.getScopeSessionIDs(requestedSessionID, scope)
    if (usefulMetricsFor(requestedIDs).length > 0) {
      return { rootID: requestedSessionID, ids: requestedIDs }
    }

    const alias = aliasScopeSessionIDs(requestedSessionID, scope)
    if (alias) {
      const fallbackKey = `${requestedSessionID}->${alias.rootID}`
      if (!loggedFallbacks.has(fallbackKey)) {
        loggedFallbacks.add(fallbackKey)
        log(`sidebar session alias: requested=${requestedSessionID || "(empty)"} metrics=${alias.rootID}`)
      }
      return alias
    }

    return { rootID: requestedSessionID, ids: requestedIDs }
  }

  function aggregateByModel(ids: readonly string[], now: number, scope: MetricsScope): ModelMetrics[] {
    // Group requests by (modelID, providerID) — one row per distinct model
    // across all sub-agent sessions, with a ×N session count.
    const modelGroups = new Map<string, RequestMetrics[]>()

    for (const id of ids) {
      const request = state.requests.get(id)
      if (!request) continue

      // Key: modelID|providerID (model-grouped, not per-session)
      const key = `${request.modelID}|${request.providerID}`
      const group = modelGroups.get(key) ?? []
      group.push(request)
      modelGroups.set(key, group)
    }

    const result: ModelMetrics[] = []

    for (const [key, metrics] of modelGroups) {
      const [modelID, providerID] = key.split("|")

      // Use aggregateRequestMetrics logic but per-model
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let exactCacheCount = 0
      let requestStartTime = Number.POSITIVE_INFINITY
      let firstTokenTime: number | null = null
      let completeTime: number | null = null
      let isStreaming = false
      let isComplete = true
      const sessionCount = new Set(metrics.map((m) => m.sessionID)).size

      for (const m of metrics) {
        inputTokens += getDisplayInputTokens(m)
        outputTokens += getDisplayOutputTokens(m)
        if (m.hasExactCacheReadTokens) {
          cacheReadTokens += Math.max(0, m.exactCacheReadTokens)
          exactCacheCount += 1
        }
        requestStartTime = Math.min(requestStartTime, m.requestStartTime)
        if (m.firstTokenTime !== null) {
          firstTokenTime = firstTokenTime === null ? m.firstTokenTime : Math.min(firstTokenTime, m.firstTokenTime)
        }
        if (m.completeTime !== null) {
          completeTime = completeTime === null ? m.completeTime : Math.max(completeTime, m.completeTime)
        }
        isStreaming = isStreaming || m.isStreaming
        isComplete = isComplete && m.isComplete
      }

      const cacheReadCompleteness: CacheReadCompleteness =
        exactCacheCount === 0 ? "unknown" : exactCacheCount === metrics.length ? "exact" : "partial"
      // Model rows use the same turn-level TTFT as the main aggregate: the
      // earliest gated turn TTFT across the group's sessions, falling back to
      // per-request TTFT when no turn timing exists (e.g. sub-agent sessions
      // whose turn start coincides with their first request).
      let ttft: number | null = null
      for (const m of metrics) {
        const candidate = getTurnTtft(state.turns.get(m.sessionID), getTtft(m))
        if (candidate !== null && (ttft === null || candidate < ttft)) ttft = candidate
      }

      // Live TPS for this model group
      let liveTps = 0
      let liveRateCount = 0
      for (const m of metrics) {
        const rate = getLiveTps(state.liveSpeeds.get(m.sessionID), now)
        if (rate !== null) {
          liveTps += rate
          liveRateCount += 1
        }
      }

      // TPS logic (same as main aggregate with the same timing sanity check):
      // - Streaming with live samples: live rolling-window TPS.
      // - Complete: freeze final average TPS (firstTokenTime preferred,
      //   requestStartTime as end-to-end fallback).
      // - Active but no live samples: running average to `now`.
      // Negative timestamps (messages predating this TUI process) are unusable
      // for rate math — treated as missing.
      let displayTps: number | null = null
      if (liveRateCount > 0 && !isComplete) {
        // Live TPS must pass the same sanity gate: replay bursts can seed
        // absurd windowed rates (1300+ t/s) which are never real.
        const saneLive = Number.isFinite(liveTps) && liveTps >= 0 && liveTps <= 300
        if (saneLive) {
          displayTps = Math.round(liveTps * 10) / 10
        }
      }
      if (displayTps === null && metrics.length > 0) {
        // Frozen TPS: use the LATEST request's own tokens and timing so the
        // numerator and denominator describe the same generation. The summed
        // `outputTokens` spans multiple requests; dividing it by the group
        // window would inflate the rate (e.g. 1800+ t/s). "Latest" is by
        // requestStartTime (chronological), not array order (tree DFS).
        const latest = metrics.reduce((a, b) => (b.requestStartTime >= a.requestStartTime ? b : a))
        const frTokens = getDisplayOutputTokens(latest)
        const genStart = latest.firstTokenTime ?? latest.requestStartTime
        const genEnd = isComplete && completeTime !== null ? completeTime : now
        const saneStart = genStart !== null && Number.isFinite(genStart) && genStart >= 0 && genStart <= now
        const saneEnd = genEnd !== null && Number.isFinite(genEnd) && genEnd >= 0 && genEnd <= now + 60_000
        if (frTokens > 0 && saneStart && saneEnd && genEnd > genStart) {
          displayTps = Math.round((frTokens / ((genEnd - genStart) / 1000)) * 10) / 10
        }
      }

      result.push({
        modelID,
        providerID,
        sessionID: providerID,
        sessionCount,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheReadCompleteness,
        requestStartTime: requestStartTime === Number.POSITIVE_INFINITY ? now : requestStartTime,
        firstTokenTime,
        completeTime: isComplete ? completeTime ?? now : null,
        ttft,
        liveTps: displayTps,
        isStreaming,
        isComplete,
      })
    }

    // Sort by provider then model
    return result.sort((a, b) => {
      const providerCompare = a.providerID.localeCompare(b.providerID)
      if (providerCompare !== 0) return providerCompare
      return a.modelID.localeCompare(b.modelID)
    })
  }

  return {
    getCurrent(sessionID: string): RequestMetrics | null {
      const requestedSessionID = normalizeSessionID(sessionID)
      hydrate(requestedSessionID)
      return state.requests.get(resolveMetricsSessionID(requestedSessionID)) ?? null
    },
    getAggregate(sessionID: string, scope: MetricsScope, now = performance.now()): MetricsAggregate | null {
      const requestedSessionID = normalizeSessionID(sessionID)
      hydrate(requestedSessionID)
      if (scope === "tree") hydrateTree(requestedSessionID)

      // Serve from cache when fresh: multiple rows request the same aggregate
      // within one render tick.
      const cacheKey = `${requestedSessionID}:${scope}`
      if (cacheKey === aggregateCacheKey && now - aggregateCacheAt < AGGREGATE_CACHE_TTL_MS) {
        return aggregateCacheValue
      }

      const { rootID, ids } = scopeSessionIDs(requestedSessionID, scope)
      const foregroundTurn = state.turns.get(rootID)
      const foregroundRequest = state.requests.get(rootID)

      if (!foregroundTurn && !foregroundRequest) return null

      const foregroundTurnStart = foregroundTurn?.turnStartTime ?? foregroundRequest!.requestStartTime
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let cacheExactCount = 0
      let contributingCount = 0
      let liveTps = 0
      let liveRateCount = 0
      let isStreaming = false
      const contributingSessionIDs: string[] = []

      for (const id of ids) {
        const turn = state.turns.get(id)
        const request = state.requests.get(id)
        if (!turn && !request) continue
        const belongsToForegroundTurn = id === rootID
          || Boolean(turn && (turn.turnStartTime >= foregroundTurnStart || !turn.isComplete))
        if (belongsToForegroundTurn) {
          const sessionInput = turn ? turnInputTokens(turn, request) : request ? getDisplayInputTokens(request) : 0
          const sessionOutput = turn
            ? turn.finalizedOutputTokens + liveRequestOutput(turn, request)
            : request ? getDisplayOutputTokens(request) : 0
          const hasContribution = sessionInput > 0 || sessionOutput > 0 || Boolean(request?.isStreaming)
          if (hasContribution) {
            inputTokens += sessionInput
            outputTokens += sessionOutput
            contributingCount += 1
            contributingSessionIDs.push(id)
            if (turn?.hasStickyCacheReadTokens) {
              cacheReadTokens += turn.stickyCacheReadTokens
              cacheExactCount += 1
            } else if (!turn && request?.hasExactCacheReadTokens) {
              cacheReadTokens += Math.max(0, request.exactCacheReadTokens)
              cacheExactCount += 1
            }
          }
        }

        const rate = getLiveTps(state.liveSpeeds.get(id), now)
        if (rate !== null) {
          liveTps += rate
          liveRateCount += 1
        }
        isStreaming = isStreaming || Boolean(request?.isStreaming)
      }

      const cacheReadCompleteness: CacheReadCompleteness = cacheExactCount === 0
        ? "unknown"
        : cacheExactCount === contributingCount ? "exact" : "partial"
      const requestStartTime = foregroundTurn?.turnStartTime ?? foregroundRequest!.requestStartTime
      const firstTokenTime = foregroundRequest?.firstTokenTime ?? null
      // Tree-scope completion semantics: the aggregate is NOT complete while
      // any contributing descendant session is still streaming, even if the
      // foreground root finished. Otherwise the frozen-TPS branch would use the
      // root's completeTime as the window end while outputTokens keeps
      // accumulating from sub-agents, understating the rate.
      const foregroundComplete = foregroundTurn?.isComplete ?? foregroundRequest?.isComplete ?? false
      const isComplete = isStreaming ? false : foregroundComplete
      const completeTime = foregroundTurn?.completeTime ?? foregroundRequest?.completeTime ?? null

      // TPS logic.
      // Timing sanity: hydration converts wall-clock times into the current
      // process's performance.now() base. Messages created BEFORE this TUI
      // process started convert to NEGATIVE timestamps. Any negative (or
      // future) timestamp is unusable for rate math — treat it as missing.
      //   - Streaming with live samples: live rolling-window TPS.
      //   - Complete: freeze final average TPS using the generation window
      //     (firstTokenTime preferred, requestStartTime as end-to-end fallback).
      //   - Active but no live samples (reopened busy session): running
      //     average to now. genEnd is ALWAYS `now` here — never a stale
      //     historical completeTime.
      let displayTps: number | null = null
      if (liveRateCount > 0 && !isComplete) {
        // Live TPS must pass the same sanity gate: replay bursts can seed
        // absurd windowed rates (e.g. 1379 t/s) which are never real.
        const saneLive = Number.isFinite(liveTps) && liveTps >= 0 && liveTps <= 300
        if (saneLive) {
          displayTps = Math.round(liveTps * 10) / 10
        }
      }
      if (displayTps === null && foregroundRequest) {
        // Frozen TPS: use the FOREGROUND request's own tokens and timing so
        // the numerator and denominator describe the same generation. In tree
        // scope `outputTokens` is summed across sub-agents — dividing that by
        // the foreground window would inflate TPS absurdly (1800+ t/s).
        const frTokens = getDisplayOutputTokens(foregroundRequest)
        const genStart = firstTokenTime ?? requestStartTime
        const genEnd = isComplete ? completeTime : now
        const saneStart = genStart !== null && Number.isFinite(genStart) && genStart >= 0 && genStart <= now
        const saneEnd = genEnd !== null && Number.isFinite(genEnd) && genEnd >= 0 && genEnd <= now + 60_000
        if (frTokens > 0 && saneStart && saneEnd && genEnd > genStart) {
          displayTps = Math.round((frTokens / ((genEnd - genStart) / 1000)) * 10) / 10
        }
      }

      // NEW: Build per-model breakdown for tree scope
      const modelBreakdown = scope === "tree" ? aggregateByModel(ids, now, scope) : []
      // Turn-level TTFT: opencode stamps step.started at the first token, so
      // intra-turn steps cannot measure their own request start (they would
      // collapse to ~0). Anchor TTFT to the turn's user message instead —
      // stable across all steps within a turn, refreshed on each new turn.
      // Falls back to the per-request measurement when no turn timing exists.
      const ttft = getTurnTtft(foregroundTurn, foregroundRequest ? getTtft(foregroundRequest) : null)

      const result: MetricsAggregate = {
        sessionIDs: contributingSessionIDs.length > 0 ? contributingSessionIDs : [rootID],
        childSessionCount: scope === "tree" ? state.sessionTree.getChildSessionCount(rootID) : 0,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheReadCompleteness,
        requestStartTime,
        firstTokenTime,
        completeTime: isComplete ? completeTime ?? now : null,
        ttft,
        liveTps: displayTps,
        isStreaming,
        isComplete,
        modelBreakdown,
      }
      aggregateCacheKey = cacheKey
      aggregateCacheAt = now
      aggregateCacheValue = result
      return result
    },
    getSessionElapsedMs(sessionID: string, scope: MetricsScope = "current", now = performance.now()): number {
      const requestedSessionID = normalizeSessionID(sessionID)
      hydrate(requestedSessionID)
      if (scope === "tree") hydrateTree(requestedSessionID)
      const { rootID, ids } = scopeSessionIDs(requestedSessionID, scope)
      if (scope === "current") return getSessionElapsedMs(state.sessionTimings.get(rootID), now)
      return getScopeElapsedMs(state.sessionTimings, ids, now)
    },
    getChildSessionCount(sessionID: string): number {
      return state.sessionTree.getChildSessionCount(sessionID)
    },
    subscribe(listener: MetricsListener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose(): void {
      disposed = true
      for (const dispose of disposers.splice(0)) dispose()
      for (const timer of state.holdTimers.values()) clearTimeout(timer)
      state.holdTimers.clear()
      state.requests.clear()
      state.turns.clear()
      state.liveSpeeds.clear()
      state.sessionTree.clear()
      state.sessionModels.clear()
      state.sessionTimings.clear()
      state.userMessageIds.clear()
      state.assistantMessageIds.clear()
      state.partTokenEstimates.clear()
      state.sessionAliases.clear()
      state.seenEventKeys.clear()
      state.seenEventOrder.length = 0
      state.lastRequestSessionID = null
      loggedFallbacks.clear()
      hydratedSessions.clear()
      hydratingSessions.clear()
      hydrationRetryAfter.clear()
      hydratedTreeRoots.clear()
      hydratingTreeRoots.clear()
      treeRetryAfter.clear()
      listeners.clear()
    },
  }
}