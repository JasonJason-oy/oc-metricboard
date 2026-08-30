/** @jsxImportSource @opentui/solid */
/** @jsxRuntime automatic */
import { createMemo, createSignal, onCleanup } from "solid-js"
import type { BoxRenderable } from "@opentui/core"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { BarConfig, MetricsAggregate, ModelMetrics } from "../types"
import type { MetricsCollector } from "../collector"
import {
    formatTokens,
    formatDuration,
    formatElapsed,
    formatCacheRead,
} from "../metrics"
import { StatRow } from "./StatRow"
import type { MetricsSidebarController } from "../tui-preferences"

// Upper bound on model-breakdown rows rendered in the sidebar. This runtime's
// JSX tree is not reactive, so rows are pre-rendered once and toggled via
// registerSync; more sub-agents than this simply scroll off.
const MAX_MODEL_ROWS = 8

interface SidebarMetricsProps {
    sessionID: string
    collector: MetricsCollector
    refreshIntervalMs: number
    barConfig: BarConfig
    theme: TuiThemeCurrent
    controller: MetricsSidebarController
    requestRender?: () => void
}

export function SidebarMetrics(props: SidebarMetricsProps) {
    let disposed = false
    let refreshQueued = false
    let interval: ReturnType<typeof setInterval> | undefined
    let unsub = () => {}
    let unsubController = () => {}
    const rowSyncs = new Set<() => void>()
    const registerRowSync = (sync: () => void) => {
        if (disposed) return () => {}
        rowSyncs.add(sync)
        return () => rowSyncs.delete(sync)
    }
    const syncRows = () => {
        if (disposed) return
        for (const sync of rowSyncs) sync()
    }
    const [tick, setTick] = createSignal(0)
    const bump = () => {
        if (disposed) return
        setTick((t) => t + 1)
        syncRows()
        if (refreshQueued) return
        refreshQueued = true
        queueMicrotask(() => {
            refreshQueued = false
            if (disposed) return
            syncRows()
            props.requestRender?.()
        })
    }

    onCleanup(() => {
        disposed = true
        refreshQueued = false
        rowSyncs.clear()
        if (interval !== undefined) clearInterval(interval)
        unsub()
        unsubController()
    })

    interval = setInterval(bump, props.refreshIntervalMs)
    unsub = props.collector.subscribe(bump)
    unsubController = props.controller.subscribe(bump)

    const sectionEnabled = createMemo(() => {
        tick()
        return props.controller.prefs().section.enabled
    })
    const requestNow = (m: MetricsAggregate): number => {
        const live = performance.now()
        return m.isComplete && m.completeTime !== null ? m.completeTime : live
    }

    const rowVisible = (key: keyof BarConfig["visible"]): boolean => {
        const barVis = props.barConfig.visible
        const rowPrefs = props.controller.prefs().rows
        return barVis[key] !== false && rowPrefs[key as keyof typeof rowPrefs] !== false
    }

    const collapsed = createMemo(() => {
        tick()
        return props.controller.collapsed()
    })
    const headerLabel = () => props.controller.prefs().section.label
    const toggleCollapsed = () => props.controller.toggleCollapsed()
    const attachBoxToggle = (node: BoxRenderable) => {
        node.onMouseDown = toggleCollapsed
    }
    const currentScope = () => props.controller.prefs().scope
    const currentAggregate = () => props.collector.getAggregate(props.sessionID, currentScope())
    const hasAggregate = () => currentAggregate() !== null
    const expandedActive = () => !collapsed() && hasAggregate()
    const expandedIdle = () => !collapsed() && !hasAggregate()
    const collapsedActive = () => collapsed() && hasAggregate()
    const frozenNow = (): number => {
        const m = currentAggregate()
        if (!m) return performance.now()
        return requestNow(m)
    }
    const speedValue = () => {
        const m = currentAggregate()
        return m?.liveTps === null || m?.liveTps === undefined ? "—" : `${m.liveTps.toFixed(1)} t/s`
    }
    const elapsedValue = () => {
        const m = currentAggregate()
        return formatElapsed(m ? frozenNow() - m.requestStartTime : 0)
    }
    const ttftValue = () => {
        const ttft = currentAggregate()?.ttft ?? null
        return ttft !== null ? formatDuration(ttft) : "--"
    }
    const tokenValue = () => {
        const m = currentAggregate()
        const inputTokens = m?.inputTokens ?? 0
        const outputTokens = m?.outputTokens ?? 0
        return `${rowVisible("input") ? `↓ ${formatTokens(inputTokens)} in` : ""}${rowVisible("input") && rowVisible("output") ? "  " : ""}${rowVisible("output") ? `↑ ${formatTokens(outputTokens)} out` : ""}`
    }
    const cacheValue = () => {
        const m = currentAggregate()
        return formatCacheRead(m?.cacheReadTokens ?? 0, m?.cacheReadCompleteness ?? "unknown")
    }
    const sessionValue = () => {
        return formatElapsed(props.collector.getSessionElapsedMs(props.sessionID, currentScope(), performance.now()))
    }

    return (
        <box
            width="100%"
            flexDirection="column"
            height={sectionEnabled() ? "auto" : 0}
        >
            <box
                width="100%"
                flexDirection="row"
                alignItems="center"
                ref={attachBoxToggle}
            >
                <text
                    fg={props.theme.text}
                >
                    <b>{collapsed() ? "▶ " : "▼ "}{headerLabel()}</b>
                </text>
            </box>

            <box width="100%" flexDirection="column">
                <StatRow
                    theme={props.theme}
                    label="Status"
                    value="No active request"
                    dim
                    icon="○"
                    visible={expandedIdle}
                    registerSync={registerRowSync}
                />
                {rowVisible("speed") && (
                    <StatRow
                        theme={props.theme}
                        label="TPS"
                        value={speedValue}
                        accent
                        icon="⚡"
                        registerSync={registerRowSync}
                        visible={expandedActive}
                    />
                )}
                {rowVisible("elapsed") && (
                    <StatRow
                        theme={props.theme}
                        label="Elapsed"
                        value={elapsedValue}
                        icon="▹"
                        registerSync={registerRowSync}
                        visible={expandedActive}
                    />
                )}
                {rowVisible("ttft") && (
                    <StatRow
                        theme={props.theme}
                        label="TTFT"
                        value={ttftValue}
                        icon="⏱"
                        registerSync={registerRowSync}
                        visible={expandedActive}
                    />
                )}
                {(rowVisible("input") || rowVisible("output")) && (
                    <StatRow
                        theme={props.theme}
                        label="Tokens"
                        value={tokenValue}
                        registerSync={registerRowSync}
                        visible={expandedActive}
                    />
                )}
                {rowVisible("cache") && (
                    <StatRow
                        theme={props.theme}
                        label="Cache"
                        value={cacheValue}
                        dim
                        icon="○"
                        registerSync={registerRowSync}
                        visible={expandedActive}
                    />
                )}
                {rowVisible("session") && (
                    <StatRow
                        theme={props.theme}
                        label="Session"
                        value={sessionValue}
                        icon="◷"
                        registerSync={registerRowSync}
                        visible={expandedActive}
                    />
                )}

                {/* NEW: Model breakdown rows for tree scope.
                    NOTE: this runtime's JSX tree is NOT reactive — the tree
                    renders once at mount. Inline .map() evaluates once, so rows
                    for sub-agents spawned later never appear. Fix: pre-render a
                    fixed number of rows that pull their data live from
                    currentAggregate() on every registerSync tick, exactly like
                    the static Speed/TTFT rows. */}
                {rowVisible("modelBreakdown") && (
                    <>
                        {Array.from({ length: MAX_MODEL_ROWS }, (_, i) => {
                            // Line 1: short model name + ×N session count.
                            const modelLabel = () => {
                                const m = currentAggregate()?.modelBreakdown[i]
                                if (!m) return ""
                                const count = m.sessionCount > 1 ? ` ×${m.sessionCount}` : ""
                                return `${m.modelID}${count}`
                            }
                            // Line 2: metrics for that model group. Compact
                            // format (no spaces after icons, no unit suffixes,
                            // single-space separators) so the data line fits the
                            // narrow sidebar on ONE line without right-edge
                            // truncation.
                            const modelValue = () => {
                                const m = currentAggregate()?.modelBreakdown[i]
                                if (!m) return ""
                                const parts: string[] = []
                                if (rowVisible("speed")) parts.push(`⚡${m.liveTps !== null ? m.liveTps.toFixed(1) : "—"}`)
                                if (rowVisible("ttft")) parts.push(`⏱${m.ttft !== null ? " " + formatDuration(m.ttft) : " --"}`)
                                if (rowVisible("input")) parts.push(`↓${formatTokens(m.inputTokens)}`)
                                if (rowVisible("output")) parts.push(`↑${formatTokens(m.outputTokens)}`)
                                return parts.join(" ")
                            }
                            const visible = () => expandedActive() && (currentAggregate()?.modelBreakdown.length ?? 0) > i
                            // The wrapper box reserves marginTop even when its
                            // children collapse to height 0, leaving blank rows
                            // while collapsed. Collapse height AND margins here.
                            let wrapperNode: BoxRenderable | undefined
                            const syncWrapper = () => {
                                if (disposed) return
                                if (!wrapperNode || wrapperNode.isDestroyed) return
                                const v = visible()
                                try {
                                    wrapperNode.height = v ? "auto" : 0
                                    wrapperNode.marginTop = v ? 1 : 0
                                    wrapperNode.marginLeft = v ? 1 : 0
                                } catch { /* ignore */ }
                            }
                            const attachWrapper = (node: BoxRenderable) => {
                                wrapperNode = node
                                syncWrapper()
                            }
                            const unregisterWrapperSync = registerRowSync(syncWrapper)
                            onCleanup(() => {
                                unregisterWrapperSync()
                            })
                            return (
                                <box key={i} ref={attachWrapper} width="100%" flexDirection="column" marginLeft={1} marginTop={1}>
                                    <StatRow
                                        theme={props.theme}
                                        label={modelLabel}
                                        value={() => ""}
                                        dim
                                        registerSync={registerRowSync}
                                        visible={visible}
                                    />
                                    <StatRow
                                        theme={props.theme}
                                        label={() => ""}
                                        value={modelValue}
                                        dim
                                        registerSync={registerRowSync}
                                        visible={visible}
                                    />
                                </box>
                            )
                        })}
                    </>
                )}

                {rowVisible("speed") && (
                    <StatRow
                        theme={props.theme}
                        label="TPS"
                        value={speedValue}
                        accent
                        icon="⚡"
                        registerSync={registerRowSync}
                        visible={collapsedActive}
                    />
                )}
                {rowVisible("session") && (
                    <StatRow
                        theme={props.theme}
                        label="Session"
                        value={sessionValue}
                        icon="◷"
                        registerSync={registerRowSync}
                        visible={collapsedActive}
                    />
                )}
            </box>
        </box>
    )
}