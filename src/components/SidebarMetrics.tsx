import { createMemo, createSignal, type JSX } from "solid-js"
import type { BoxRenderable, TextRenderable } from "@opentui/core"
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
import { element } from "./ui-element"
import type { MetricsSidebarController } from "../tui-preferences"

// Upper bound on model-breakdown rows rendered in the sidebar. This runtime's
// tree is not reactive, so rows are pre-rendered once and toggled via
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

export interface SidebarMetricsInstance {
    /** Root renderable for the host slot. Treated as the host's `JSX.Element` (same lie the old jsx-runtime types told). */
    node: JSX.Element
    /** Clears timers/subscriptions/syncs. Call from the plugin setup cleanup path. */
    dispose: () => void
}

export function SidebarMetrics(props: SidebarMetricsProps): SidebarMetricsInstance {
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

    // Explicit disposal replacing the old onCleanup: the V2 Node loader builds
    // this tree outside a dispose-owned JSX scope, so onCleanup was wired to a
    // scope we do not control. The setup cleanup path (tui.tsx onDispose /
    // tui-v2.tsx setup return) calls this instead.
    const dispose = () => {
        if (disposed) return
        disposed = true
        refreshQueued = false
        rowSyncs.clear()
        if (interval !== undefined) clearInterval(interval)
        unsub()
        unsubController()
    }

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
    // This runtime's tree is non-reactive: the header <text> nodes are built
    // once at mount, so the ▶/▼ arrow would freeze on its initial value. Two
    // static bold nodes (collapsed/expanded) are pre-rendered and toggled
    // imperatively through registerSync — the same mechanism as the rows.
    // Hidden node must be zero-sized in BOTH axes: visible=false only
    // suppresses painting, while yoga still reserves its box, which would
    // offset the visible label. No value imports from @opentui/core beyond
    // what mount already exercised, so version drift can't break the plugin.
    let collapsedHeaderNode: TextRenderable | undefined
    let expandedHeaderNode: TextRenderable | undefined
    const syncHeader = () => {
        if (disposed) return
        const isCollapsed = collapsed()
        for (const [node, visible] of [
            [collapsedHeaderNode, isCollapsed],
            [expandedHeaderNode, !isCollapsed],
        ] as const) {
            if (!node || node.isDestroyed) continue
            try {
                node.visible = visible
                if (visible) {
                    node.width = "auto"
                    node.height = "auto"
                } else {
                    node.width = 0
                    node.height = 0
                }
            } catch { /* cosmetic — ignore layout failures */ }
        }
    }
    // Unregistered wholesale by dispose() via rowSyncs.clear() (the old
    // per-sync onCleanup unregister went with the JSX scope).
    registerRowSync(syncHeader)
    const attachCollapsedHeaderNode = (node: TextRenderable) => {
        collapsedHeaderNode = node
        syncHeader()
    }
    const attachExpandedHeaderNode = (node: TextRenderable) => {
        expandedHeaderNode = node
        syncHeader()
    }
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

    // --- tree (same hierarchy/spacing/order as the old JSX) ------------------
    const headerBox = element("box", {
        width: "100%",
        flexDirection: "row",
        alignItems: "center",
        ref: attachBoxToggle,
    }, [
        element("text", {
            ref: attachCollapsedHeaderNode,
            fg: props.theme.text,
            visible: false,
        }, [
            element("b", {}, ["▶ ", headerLabel()]),
        ]),
        element("text", {
            ref: attachExpandedHeaderNode,
            fg: props.theme.text,
        }, [
            element("b", {}, ["▼ ", headerLabel()]),
        ]),
    ])

    const rows: unknown[] = []
    rows.push(StatRow({
        theme: props.theme,
        label: "Status",
        value: "No active request",
        dim: true,
        icon: "○",
        visible: expandedIdle,
        registerSync: registerRowSync,
    }))
    if (rowVisible("speed")) {
        rows.push(StatRow({
            theme: props.theme,
            label: "TPS",
            value: speedValue,
            accent: true,
            icon: "⚡",
            registerSync: registerRowSync,
            visible: expandedActive,
        }))
    }
    if (rowVisible("elapsed")) {
        rows.push(StatRow({
            theme: props.theme,
            label: "Elapsed",
            value: elapsedValue,
            icon: "▹",
            registerSync: registerRowSync,
            visible: expandedActive,
        }))
    }
    if (rowVisible("ttft")) {
        rows.push(StatRow({
            theme: props.theme,
            label: "TTFT",
            value: ttftValue,
            icon: "⏱",
            registerSync: registerRowSync,
            visible: expandedActive,
        }))
    }
    if (rowVisible("input") || rowVisible("output")) {
        rows.push(StatRow({
            theme: props.theme,
            label: "Tokens",
            value: tokenValue,
            registerSync: registerRowSync,
            visible: expandedActive,
        }))
    }
    if (rowVisible("cache")) {
        rows.push(StatRow({
            theme: props.theme,
            label: "Cache",
            value: cacheValue,
            dim: true,
            icon: "○",
            registerSync: registerRowSync,
            visible: expandedActive,
        }))
    }
    if (rowVisible("session")) {
        rows.push(StatRow({
            theme: props.theme,
            label: "Session",
            value: sessionValue,
            icon: "◷",
            registerSync: registerRowSync,
            visible: expandedActive,
        }))
    }

    // Model breakdown rows for tree scope. This runtime's tree is NOT
    // reactive — it is built once at mount, so inline .map() evaluates once:
    // rows for sub-agents spawned later would never appear. Fix: pre-render a
    // fixed number of rows that pull their data live from currentAggregate()
    // on every registerSync tick, exactly like the static Speed/TTFT rows.
    if (rowVisible("modelBreakdown")) {
        for (let i = 0; i < MAX_MODEL_ROWS; i++) {
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
            // Wrapper syncs are unregistered wholesale by dispose() via
            // rowSyncs.clear() (the old per-row onCleanup unregister went
            // with the JSX scope).
            registerRowSync(syncWrapper)
            rows.push(element<BoxRenderable>("box", {
                ref: attachWrapper,
                width: "100%",
                flexDirection: "column",
                marginLeft: 1,
                marginTop: 1,
            }, [
                StatRow({
                    theme: props.theme,
                    label: modelLabel,
                    value: () => "",
                    dim: true,
                    registerSync: registerRowSync,
                    visible,
                }),
                StatRow({
                    theme: props.theme,
                    label: () => "",
                    value: modelValue,
                    dim: true,
                    registerSync: registerRowSync,
                    visible,
                }),
            ]))
        }
    }

    if (rowVisible("speed")) {
        rows.push(StatRow({
            theme: props.theme,
            label: "TPS",
            value: speedValue,
            accent: true,
            icon: "⚡",
            registerSync: registerRowSync,
            visible: collapsedActive,
        }))
    }
    if (rowVisible("session")) {
        rows.push(StatRow({
            theme: props.theme,
            label: "Session",
            value: sessionValue,
            icon: "◷",
            registerSync: registerRowSync,
            visible: collapsedActive,
        }))
    }

    const contentBox = element("box", {
        width: "100%",
        flexDirection: "column",
    }, rows)

    const root = element("box", {
        width: "100%",
        flexDirection: "column",
        height: sectionEnabled() ? "auto" : 0,
    }, [headerBox, contentBox])

    return { node: root as unknown as JSX.Element, dispose }
}
