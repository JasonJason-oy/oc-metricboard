# oc-metricboard

OpenCode TUI sidebar plugin for real-time LLM metrics (TPS / TTFT / token usage) with **sub-agent aggregation** and **per-model breakdown**.

Based on [opencode-metrics](https://github.com/nxxxsooo/opencode-metrics) with a streamlined display, sub-agent × model grouping, and production-hardening fixes.

## Features

- **Real-time TPS** — live rolling-window rate while streaming, frozen average on completion (sanity-gated against absurd values)
- **TTFT** — time to first token, anchored to the user message (not the lazy `step.started` event)
- **Token usage** — exact input/output counts from provider (estimated fallback)
- **Sub-agent aggregation** (`scope: "tree"`) — merges all descendant sub-agent sessions
- **Per-model breakdown** — one row per distinct model with `×N` session count
- **Collapsed quick-view** — keeps a compact TPS + Session summary while collapsed
- **Compact layout** — no vertical gaps, no value truncation in narrow sidebars

### Display

```
▼ MetricBoard
  TPS             ⚡ 116.9 t/s
  Elapsed         ▹ 1m5s
  TTFT            ⏱ 57.8s
  Tokens          ↓ 603.1K in  ↑ 3.9K out
  Session         ◷ 1m49s

  deepseek-v4-flash
      ⚡116.9 ⏱7.8s ↓595.9K ↑902
  mimo-v2.5-free ×4
      ⚡67.3 ⏱2.1s ↓78.3K ↑5.0K
```

## Installation

### From npm (after publishing)

```bash
opencode plugin oc-metricboard --global
```

or add to your config:

```json
{
  "plugin": ["oc-metricboard"]
}
```

### Local development (tarball)

```json
{
  "plugin": ["file:///absolute/path/to/oc-metricboard-0.1.4.tgz"]
}
```

Restart OpenCode TUI afterwards. Plugins load at TUI startup and are not hot-reloaded.

## Configuration

Preferences live in `~/.config/opencode/tui-preferences.jsonc` under the `oc-metricboard` key:

```jsonc
{
  "oc-metricboard": {
    "scope": "tree",              // "current" | "tree" — tree enables sub-agent aggregation
    "section": {
      "enabled": true,
      "collapsed": false,
      "rememberCollapsed": true,
      "label": "MetricBoard"
    },
    "rows": {
      "tps": true,                // TPS row (renamed from "speed")
      "ttft": true,               // Time to first token
      "input": true,              // Input tokens
      "output": true,             // Output tokens
      "cache": false,             // Cache read tokens (off by default)
      "elapsed": true,            // Request elapsed time
      "session": true,            // Session cumulative time
      "modelBreakdown": true      // Per-model rows in tree scope
    }
  }
}
```

Runtime behavior (`refreshIntervalMs`, `holdDurationMs`, `estimationRatio`, `enableLogging`) is read from `~/.config/opencode/opencode-bar.json`:

```jsonc
{
  "refreshIntervalMs": 200,
  "holdDurationMs": 0,
  "estimationRatio": 4.0,
  "enableLogging": false
}
```

## How it works

The plugin subscribes to OpenCode events:

- `session.created/updated/status` — builds the session tree
- `message.part.delta`, `session.next.text.delta` — live token estimation and TPS window
- `session.next.step.started/ended` — exact token counts from provider
- `message.updated` — model attribution and exact counts
- `session.idle` — request completion

For **tree scope** it additionally:

1. Queries `session.children` (SDK client) to build the sub-agent hierarchy
2. Hydrates descendant sessions via the async SDK client (`session.messages` / `session.status`)
3. Groups requests by `(modelID, providerID)`, summing tokens and pooling sessions into a `×N` count
4. Renders one compact two-line entry per model group

### Design notes

- **Aggregate cache** (150 ms TTL): multiple sidebar rows share one aggregation pass per render tick to avoid redundant O(tree) work and UI jank.
- **TTFT anchor**: uses the preceding user message's created time — opencode 1.18.x stamps `step.started` lazily at the first token, which would otherwise collapse TTFT to ~0.
- **Timing sanity**: negative timestamps (from hydrating messages older than the TUI process) and implausible spans are reported as `--`, not garbage numbers.
- **Hydration bounds**: at most 5 attempts per session; a session with no token history is not retried forever.

## Development

```bash
npm install
npm run build        # tsup bundle check
npm test             # bun test (requires bun)
npm pack --dry-run   # verify publish contents
```

## Credits

Forked from [opencode-metrics](https://github.com/nxxxsooo/opencode-metrics) by nxxxsooo, itself a rewrite of [Icicno/opencodeBar](https://github.com/Icicno/opencodeBar).

## License

MIT
