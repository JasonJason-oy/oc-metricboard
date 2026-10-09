// Local-development entrypoint (OpenCode directory plugins).
//
// OpenCode loads a directory-local plugin by looking for a root-level `tui`
// module; package.json exports are NOT consulted for directory plugins
// (Host.resolve -> resolveModule(path.join(directory, "tui"), directory)).
// npm-installed plugins keep using the package.json `./tui` export ->
// ./dist/tui.js, so this file is only for editing/loading the repo directly.
export { default } from "./dist/tui.js"
