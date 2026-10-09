/**
 * No-op server-side plugin.
 *
 * Exists only so opencode's server can resolve and load a valid `./server`
 * entrypoint. The /plugins panel shows a package version only for server
 * entries that load successfully; without this entrypoint the server falls
 * back to the TUI bundle (which imports @opentui/solid and cannot load in the
 * server process), so no version is displayed.
 *
 * Keep this dependency-free: it must NOT import @opentui/solid, solid-js, or
 * any UI module.
 */
const plugin: { id: string; setup: (ctx: unknown) => () => void } = {
  id: "oc-metricboard",
  setup() {
    return () => {}
  },
}

export default plugin
