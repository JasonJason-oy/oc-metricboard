/**
 * OpenCode V2 TUI entry (dual-host compatibility).
 *
 * OpenCode V2 (2.0.x) rejects V1-only `{ id, tui }` modules: its TUI loader
 * validates `{ id, setup }`. One `./tui` module exporting BOTH keys satisfies
 * both hosts — each reads its own key and ignores the other (the pattern
 * proven by oh-my-opencode-slim and opencode-tps-meter).
 *
 * V2 surface mapping used here (vs the V1 `tui(api, options, meta)` entry in
 * src/tui.tsx):
 *
 *   api.event.on(type, handler)        -> ctx.data.on(v2Type, handler)
 *   api.slots.register({ slots })      -> ctx.ui.slot({ append, render })
 *   slot props.session_id (required)   -> render input.sessionID (optional)
 *   api.renderer.requestRender()       -> ctx.renderer?.requestRender?.()
 *   api.lifecycle.onDispose(fn)        -> cleanup returned from setup
 *
 * Event vocabulary (V2 -> the V1 names the collector understands):
 *
 *   session.text.delta            -> session.next.text.delta
 *   session.reasoning.delta       -> session.next.reasoning.delta
 *   session.step.started          -> session.next.step.started
 *   session.step.ended            -> session.next.step.ended
 *   session.idle                  -> session.idle          (unchanged)
 *   session.execution.started     -> session.status (busy) (turn start)
 *
 * The V2 payloads are field-compatible with the V1 parsers
 * (`assistantMessageID`, `tokens: { input, output, reasoning,
 * cache: { read, write } }`), so events are forwarded as-is; only
 * execution.started needs a real translation. The event shim hides all of
 * this behind the V1 `api.event.on` contract, so the collector and every
 * event handler run unmodified on both hosts.
 *
 * Deliberately absent in the V2 port (degrades gracefully):
 * - session hydration / historical token restore (the V2 client dialect
 *   differs; live tracking is unaffected) — the collector's hydration API
 *   check simply fails, so no failing requests are fired
 * - message.updated passthrough (user-message turn anchor) — turn start is
 *   covered by session.execution.started / step.started
 */
/** @jsxImportSource @opentui/solid */
/** @jsxRuntime automatic */
import { createCollector, type MetricsCollector } from "./collector"
import type { MetricsEventApi } from "./event-bus"
import { getConfig } from "./config"
import { log } from "./logger"
import { SidebarMetrics } from "./components/SidebarMetrics"
import {
    computeEffectiveOrder,
    createMetricsSidebarController,
    DEFAULT_SLOT_ORDER,
    PLUGIN_KEY,
    resolveMetricsPrefs,
} from "./tui-preferences"
import { readTuiPreferencesFileSync } from "./tui-prefs-io"

// ---------------------------------------------------------------------------
// Minimal structural types for the V2 TUI context (mirrors @opencode/plugin/tui
// beta; declared locally so the package keeps zero hard deps on the V2 scope).
// ---------------------------------------------------------------------------

interface V2Theme {
    readonly text?: {
        readonly default?: unknown
        readonly subdued?: unknown
        readonly feedback?: Readonly<Record<string, { readonly default?: unknown } | undefined>>
    }
    readonly [key: string]: unknown
}

interface V2EventLike {
    readonly type?: unknown
    readonly data?: unknown
    readonly [key: string]: unknown
}

interface V2Context {
    readonly options?: Readonly<Record<string, unknown>>
    readonly theme?: V2Theme
    readonly renderer?: { readonly requestRender?: () => void }
    readonly data?: {
        readonly on: (type: string, handler: (event: unknown) => void) => () => void
        readonly session?: {
            readonly root: (sessionID: string) => string
            readonly family: (sessionID: string) => string[]
        }
    }
    readonly ui: {
        readonly slot: (claim: {
            readonly render: (input: { readonly sessionID?: string; readonly mode?: string }) => unknown
            readonly append?: string
            readonly after?: string
        }) => () => void
    }
}

type V2Cleanup = () => void

// ---------------------------------------------------------------------------
// Event bridge: V1 api.event.on contract over V2 ctx.data.on.
// ---------------------------------------------------------------------------

/** V1 event name -> V2 event name. `null` = no V2 equivalent (no-op). */
const V2_EVENT_MAP: Readonly<Record<string, string | null>> = {
    "message.part.delta": null,
    "message.part.updated": null,
    "message.updated": null,
    "session.created": "session.created",
    "session.updated": "session.updated",
    "session.deleted": "session.deleted",
    "session.status": null,
    "session.idle": "session.idle",
    "session.next.text.delta": "session.text.delta",
    "session.next.reasoning.delta": "session.reasoning.delta",
    "session.next.step.started": "session.step.started",
    "session.next.step.ended": "session.step.ended",
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
    return typeof value === "string" ? value : ""
}

/**
 * `session.execution.started` = "the user's prompt was admitted and work
 * started" — the V2 equivalent of V1's `session.status -> busy`, which drives
 * turn start and session timing. Exported for tests.
 */
export function translateExecutionStartedToBusy(event: V2EventLike): unknown {
    const data = isRecord(event.data) ? event.data : {}
    const sessionID = str(data.sessionID)
    if (!sessionID) return null
    // Preserve the host stamp so downstream timing uses generation time,
    // not the (possibly batched) delivery time.
    const created = typeof event.created === "number" ? event.created : undefined
    return {
        type: "session.status",
        ...(created !== undefined ? { created } : {}),
        properties: { sessionID, status: { type: "busy" } },
    }
}

/**
 * Turn-settled execution maps to the V1 `session.idle` shape that drives
 * request completion. Used as a fallback next to the native V2
 * `session.idle`, which some flows never emit. Exported for tests.
 */
export function translateExecutionSettledToIdle(event: V2EventLike): unknown {
    const data = isRecord(event.data) ? event.data : {}
    const sessionID = str(data.sessionID)
    if (!sessionID) return null
    const created = typeof event.created === "number" ? event.created : undefined
    return {
        type: "session.idle",
        ...(created !== undefined ? { created } : {}),
        properties: { sessionID },
    }
}

function eventSessionID(event: unknown): string {
    if (!isRecord(event)) return ""
    return str(isRecord(event.data) ? event.data.sessionID : undefined)
}

interface CollectorHolder {
    collector: MetricsCollector | null
}

function createV1EventShim(ctx: V2Context, holder: CollectorHolder): MetricsEventApi {
    let lastFamilySyncAt = -Infinity
    const syncFamily = (sessionID: string): void => {
        const data = ctx.data
        try {
            if (!holder.collector || !data?.session || !sessionID) return
            const now = Date.now()
            if (now - lastFamilySyncAt < 2_000) return
            lastFamilySyncAt = now
            const rootID = data.session.root(sessionID)
            const ids = data.session.family(rootID) ?? []
            for (const id of ids) {
                if (id !== rootID) holder.collector.setSessionParent(id, rootID)
            }
        } catch {
            // Family attribution is best-effort; the root session works without it.
        }
    }

    const subscribeV2 = (
        v2Type: string,
        subscribee: (event: unknown) => void,
    ): (() => void) => {
        try {
            const unsub = ctx.data.on(v2Type, (event: unknown) => {
                try {
                    subscribee(event)
                } catch (error) {
                    // One malformed event must never tear down the handler chain.
                    log(`v2 event dispatch failed: ${String(error)}`)
                }
            })
            return typeof unsub === "function" ? unsub : () => {}
        } catch (error) {
            log(`v2 event subscribe failed (${v2Type}): ${String(error)}`)
            return () => {}
        }
    }

    return {
        event: {
            on(type: string, handler: (event: unknown) => void): () => void {
                // V1 hosts subscribe `.1`/`.2` delivery variants; V2 has none.
                if (/\.1$|\.2$/.test(type)) return () => {}
                // V1 session lifecycle has no same-name V2 event: synthesize
                // busy from execution.started. (Without this, turns, session
                // timing, and completion never start on V2.)
                if (type === "session.status") {
                    return subscribeV2("session.execution.started", (event) => {
                        const translated = translateExecutionStartedToBusy(event as V2EventLike)
                        if (translated !== null) handler(translated)
                    })
                }
                // Completion: native V2 session.idle where emitted, plus the
                // execution-settled events as fallback — some flows never emit
                // session.idle, which used to leave the turn/request/timing
                // open forever (TPS decaying in real time while idle).
                // completeRequest is idempotent, so a doubled signal is safe.
                if (type === "session.idle") {
                    const unsubs: Array<() => void> = [
                        subscribeV2("session.idle", handler),
                    ]
                    for (const settled of [
                        "session.execution.succeeded",
                        "session.execution.failed",
                        "session.execution.interrupted",
                    ] as const) {
                        unsubs.push(subscribeV2(settled, (event) => {
                            const translated = translateExecutionSettledToIdle(event as V2EventLike)
                            if (translated !== null) handler(translated)
                        }))
                    }
                    return () => {
                        for (const unsub of unsubs) {
                            try {
                                unsub()
                            } catch { /* ignore */ }
                        }
                    }
                }
                const v2Type = V2_EVENT_MAP[type]
                if (!v2Type) return () => {}
                return subscribeV2(v2Type, (event) => {
                    syncFamily(eventSessionID(event))
                    handler(event)
                })
            },
        },
    }
}

// ---------------------------------------------------------------------------
// Theme adapter: components read V1 flat tokens.
// NOTE: the theme shape is declared locally on purpose — tui-v2 must not
// import anything from the `@opencode-ai/*` (V1) scope, not even types: the
// V2 host installs every `@opencode-ai/*` specifier it sees into the
// plugin sandbox, pulling a second plugin runtime into the process.
// ---------------------------------------------------------------------------

/** Flat theme tokens the shared components read (V1 shape, structural). */
interface V1FlatTheme {
    readonly text?: unknown
    readonly textMuted?: unknown
    readonly accent?: unknown
    readonly warning?: unknown
    readonly success?: unknown
    readonly [key: string]: unknown
}

function pickThemeToken(theme: V2Theme | undefined, paths: ReadonlyArray<ReadonlyArray<string>>): unknown {
    for (const path of paths) {
        let value: unknown = theme
        for (const key of path) {
            if (!isRecord(value)) {
                value = undefined
                break
            }
            value = value[key]
        }
        if (value !== undefined && value !== null) return value
    }
    return undefined
}

function v1ThemeFromV2(theme: V2Theme | undefined): V1FlatTheme {
    return {
        text: pickThemeToken(theme, [["text", "default"]]),
        textMuted: pickThemeToken(theme, [["text", "subdued"]]),
        accent: pickThemeToken(theme, [["text", "feedback", "info", "default"], ["text", "default"]]),
        warning: pickThemeToken(theme, [["text", "feedback", "warning", "default"]]),
        success: pickThemeToken(theme, [["text", "feedback", "success", "default"]]),
    }
}

// ---------------------------------------------------------------------------
// V2 setup
// ---------------------------------------------------------------------------

export function setupTuiV2(ctx: V2Context): V2Cleanup {
    // The V2 host may invoke this module's `setup` in a server-side loading
    // context (capability probing), where there is no TUI surface: `ctx.ui`
    // is undefined. Bail out silently instead of throwing — the real TUI
    // setup runs where `ctx.ui.slot` exists. (The sidebar already renders;
    // this path is only the server-side probe.)
    if (!ctx || !ctx.ui || typeof ctx.ui.slot !== "function") {
        log("opencode-metrics v2 entry: no ui.slot in this context, skipping")
        return () => {}
    }
    const config = getConfig()
    log("opencode-metrics v2 entry initialized")

    const seedRoot = readTuiPreferencesFileSync()
    const effectiveOrder = computeEffectiveOrder(seedRoot, PLUGIN_KEY, DEFAULT_SLOT_ORDER)
    const prefs = resolveMetricsPrefs(seedRoot)
    const requestRender = (): void => {
        try {
            ctx.renderer?.requestRender?.()
        } catch { /* rendering is host-driven in v2; ignore failures */ }
    }
    const controller = createMetricsSidebarController(prefs, requestRender)

    const holder: CollectorHolder = { collector: null }
    const collector = createCollector(createV1EventShim(ctx, holder), config, log)
    holder.collector = collector

    const theme = v1ThemeFromV2(ctx.theme)
    const disposers: Array<() => void> = []

    // The sidebar is the ONE surface that must exist; claim it outside any guard.
    disposers.push(
        ctx.ui.slot({
            append: "sidebar.content",
            render: (input) => {
                const sessionID = input?.sessionID ?? ""
                if (!sessionID) return <box />
                return (
                    <SidebarMetrics
                        sessionID={sessionID}
                        collector={collector}
                        refreshIntervalMs={config.refreshIntervalMs}
                        barConfig={config}
                        theme={theme as never}
                        controller={controller}
                        requestRender={requestRender}
                    />
                )
            },
        })
    )

    return () => {
        for (const dispose of disposers) {
            try {
                dispose()
            } catch { /* ignore */ }
        }
        disposers.length = 0
        collector.dispose()
    }
}
