// Post-build step: rewrite host runtime module imports in dist to OpenCode's
// virtual runtime-module specifiers.
//
// Why: OpenCode loads npm-installed TUI plugins from a sandbox under
// node_modules. In that layout the host's OpenTUI runtime rewrite does NOT
// intercept bare `@opentui/*` / `solid-js` imports (see opencode issues
// #33884 / #39986 / #48883), so the plugin would load its own copy of
// `@opentui/solid` and crash on first render with "No renderer found"
// (dual runtime instances). Importing through the host's virtual ids
// (`opentui:runtime-module:<url-encoded specifier>`) is the
// production-validated pattern that always resolves to the host copy
// regardless of where the plugin is installed.
//
// The rewrite is text-level and runs after `tsc`, so the source keeps plain
// JSX authoring; only the emitted import specifiers change.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const distDir = path.join(root, "dist")

// Same set the host routes through `opentui:runtime-module:*`, encoded with
// encodeURIComponent (the "@" and "/" forms match @opentui/core/runtime-plugin).
const RUNTIME_MODULE_IDS = {
  "@opencode/plugin/tui": "%40opencode%2Fplugin%2Ftui",
  "@opentui/core": "%40opentui%2Fcore",
  "@opentui/core/testing": "%40opentui%2Fcore%2Ftesting",
  "@opentui/solid": "%40opentui%2Fsolid",
  "@opentui/solid/components": "%40opentui%2Fsolid%2Fcomponents",
  "@opentui/solid/jsx-runtime": "%40opentui%2Fsolid%2Fjsx-runtime",
  "@opentui/solid/jsx-dev-runtime": "%40opentui%2Fsolid%2Fjsx-dev-runtime",
  "solid-js": "solid-js",
  "solid-js/store": "solid-js%2Fstore",
}

const IMPORT_PATTERNS = [
  /from\s+"([^"]+)"/g,
  /import\s+"([^"]+)"/g,
  /import\s*\(\s*"([^"]+)"\s*\)/g,
]

function rewrite(code) {
  let output = code
  for (const pattern of IMPORT_PATTERNS) {
    output = output.replace(pattern, (match, specifier) => {
      const encoded = RUNTIME_MODULE_IDS[specifier]
      return encoded ? match.replace(specifier, `opentui:runtime-module:${encoded}`) : match
    })
  }
  return output
}

function collectJsFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectJsFiles(full, files)
    else if (entry.name.endsWith(".js")) files.push(full)
  }
  return files
}

function main() {
  const files = collectJsFiles(distDir)
  if (files.length === 0) {
    console.error(`rewrite-runtime-imports: no JS files under ${distDir} (run "npm run build" first)`)
    process.exit(1)
  }

  let changed = 0
  for (const file of files) {
    const original = readFileSync(file, "utf8")
    const rewritten = rewrite(original)
    if (rewritten !== original) {
      writeFileSync(file, rewritten)
      changed++
      console.log(`rewrite-runtime-imports: ${path.relative(root, file)}`)
    }
  }

  // Fail loudly if any host runtime specifier is still imported as a bare specifier.
  const leftovers = []
  for (const file of files) {
    const code = readFileSync(file, "utf8")
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of code.matchAll(pattern)) {
        const specifier = match[1]
        if (Object.hasOwn(RUNTIME_MODULE_IDS, specifier)) leftovers.push(`${path.relative(root, file)} -> ${specifier}`)
      }
    }
  }
  if (leftovers.length > 0) {
    console.error("rewrite-runtime-imports: unresolved host runtime imports:\n" + leftovers.join("\n"))
    process.exit(1)
  }

  console.log(`rewrite-runtime-imports: done (${changed} file(s) rewritten, ${files.length} checked)`)
}

main()
