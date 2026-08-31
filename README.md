# Excalidraw MCP Server

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Live Excalidraw canvas controlled by AI agents via MCP tools. Draw, inspect, iterate, export — all programmatically.

> Fork of [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw), based on upstream **v2.0.0**, with multi-canvas support, shared server architecture, undo/redo, batch updates, and `mcp-call` integration.

## Install

Works with Claude Code, Codex CLI, Cursor, and any skills-compatible agent:
```bash
npx skills add wise-toddler/mcp_excalidraw@excalidraw-skill -g
```

The agent auto-handles setup — clones, builds, launches canvas server, registers with `mcp-call`. No manual config needed.

## Quick Start (Manual)

```bash
git clone https://github.com/wise-toddler/mcp_excalidraw && cd mcp_excalidraw
npm ci && npm run build
bash launch.sh
```

Output:
```
Canvas:   http://127.0.0.1:59189/?canvasId=canvas-abc123
Canvases: http://127.0.0.1:59189/canvases
MCP:      mcp-call excalidraw-canvas-abc123 <tool> ...
CLI:      node /path/to/mcp_excalidraw/dist/bin.js --url http://127.0.0.1:59189 --canvas canvas-abc123 <command>
```

Open the canvas URL in your browser. Use `mcp-call` (or the CLI line) to interact.

## Architecture

```
Claude Session 1 ─┐
Claude Session 2 ──┤── launch.sh ──→ Shared Express Server (1 port) ──→ Canvas A
Claude Session 3 ──┘         ↓                    ├──→ Canvas B
                     reuses if running             ├──→ Canvas C
                                                   └──→ /canvases dashboard
```

- **Shared server** — one process, one port, no zombie processes
- **Multi-canvas** — each session gets its own isolated canvas, selected with `?canvasId=…` or an `x-canvas-id` header
- **Auto-open browser** — browser-dependent tools (screenshot, viewport, mermaid, undo/redo) open the canvas page if no tab is connected
- **mcp-call** — stateless MCP proxy spawned per call, canvas state lives in the Express server

## MCP Tools (30)

| Category | Tools |
|---|---|
| **Element CRUD** | `create_element`, `get_element`, `update_element`, `delete_element`, `query_elements`, `batch_create_elements`, `batch_update_elements`, `duplicate_elements` |
| **Layout** | `align_elements`, `distribute_elements`, `group_elements`, `ungroup_elements`, `lock_elements`, `unlock_elements` |
| **Scene** | `describe_scene`, `get_canvas_screenshot` |
| **History** | `undo`, `redo` |
| **File I/O** | `export_scene`, `import_scene`, `export_to_image`, `export_to_excalidraw_url`, `create_from_mermaid` |
| **State** | `clear_canvas`, `snapshot_scene`, `restore_snapshot` |
| **Viewport** | `set_viewport` |
| **Session** | `get_canvas_url` |
| **Guide** | `read_diagram_guide` |
| **Resources** | `get_resource` |

`create_element` / `batch_create_elements` also accept `labelPosition` — `center` (default) binds a centered label, any corner/edge value emits a free-standing text element inside the shape (the clean way to title a background zone).

## CLI

The same canvas is drivable from the shell with the `CLI:` line `launch.sh` prints: `node dist/bin.js --url <serverUrl> --canvas <canvasId> <command>`. `--url`/`--canvas` are global flags (equivalent to `EXPRESS_SERVER_URL`/`CANVAS_ID`), and they matter — without `--canvas` the CLI drives the `default` canvas instead of your session's. Commands: `status`, `add`, `apply`, `get`, `query`, `update`, `delete`, `describe`, `screenshot`, `export`, `import`, `mermaid`, `share`, `snapshot`, `arrange`, `clear`, `install-skill`. Results are JSON on stdout (`describe` is plain text); exit codes are 0 ok, 1 error, 2 usage, 3 canvas unreachable, 4 browser tab required. Exporting to a `.excalidraw.md` path writes the Obsidian Excalidraw plugin's native format, so diagrams can live directly in a vault.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Canvas server port | `3000` (launch.sh picks a free one) |
| `EXPRESS_SERVER_URL` | Canvas server URL (for MCP/CLI) | `http://127.0.0.1:3000` |
| `CANVAS_ID` | Canvas this process drives (CLI: `--canvas`) | `default` |
| `ENABLE_CANVAS_SYNC` | Sync MCP writes to the canvas | `true` |
| `EXCALIDRAW_NO_AUTOSTART` | `1` disables auto-spawning the canvas server (launch.sh sets it on the MCP server it registers) | unset |
| `EXCALIDRAW_NO_BROWSER_OPEN` | `1` disables headless browser auto-open (tests/CI) | unset |
| `EXCALIDRAW_EXPORT_DIR` | `path.delimiter`-separated allowlist for export/import paths; the OS temp dir and `/tmp` are always allowed | process cwd |
| `LOG_FILE_PATH` | Server log file | `~/Library/Logs/excalidraw-mcp.log` (macOS; XDG state dir on Linux) |

## Testing

```bash
npm run test:unit     # 140 unit + integration tests (vitest)
npm test              # test:unit + MCP stdio wire test + local-bind regression test
npm run build         # TypeScript + frontend build
npm run type-check    # tsc --noEmit
```

## Development

```
src/
├── server.ts              # Express canvas server entry (REST + WebSocket)
├── index.ts               # MCP stdio server entry
├── bin.ts                 # CLI entry (dist/bin.js); global --url / --canvas flags
├── canvases.ts            # Multi-canvas registry + canvasId resolution (query / x-canvas-id)
├── canvas-routes.ts       # Fork routes: /api/canvases, batch-update, undo/redo
├── browser-open.ts        # Headless auto-open of the canvas page
├── types.ts               # Shared types + canvas state
├── core/                  # Shared logic behind MCP, CLI, and REST
│   ├── canvas-client.ts   # Single HTTP choke point (threads canvasId through)
│   ├── canvas-state.ts    # Per-canvas element/file/snapshot stores
│   ├── canvas-dashboard.ts# /canvases HTML renderer
│   ├── config.ts          # Env config, canvasId helpers, export allowlist
│   ├── mcp-tools.ts       # 30 tool schemas
│   ├── mcp-dispatch.ts    # Tool handler dispatch
│   ├── mcp-server.ts      # MCP protocol wiring
│   ├── expand-elements.ts # Agent-friendly element normalization
│   ├── label-position.ts  # labelPosition → free-standing text expansion
│   ├── normalize.ts       # Points / colors / font normalization
│   ├── describe.ts        # describe_scene text rendering
│   ├── design-guide.ts    # read_diagram_guide content
│   ├── scene-io.ts        # .excalidraw import/export
│   ├── obsidian-md.ts     # .excalidraw.md (Obsidian plugin) format
│   └── share-url.ts       # Encrypted excalidraw.com share links
├── cli/                   # CLI arg parsing + command implementations
│   ├── args.ts, run.ts, util.ts
│   └── commands/          # server, elements, scene, arrange, snapshot, install-skill
├── utils/logger.ts        # Winston logger (platform-safe default path)
└── __tests__/             # 140 tests (vitest)
```

The agent skill lives in `skills/excalidraw-skill/` (single source of truth); run `npm run sync:skills` after editing it to refresh the repo-local `.agents/skills` copy.

## Releases

Fork releases are tagged `v2.0.0-fork.N` — the base upstream version plus the fork iteration.

## Upstream Docs

For per-client MCP configuration (Claude Desktop, Claude Code, Cursor, Codex CLI, OpenCode, Antigravity), Docker images, and the FAQ, see the [upstream README](https://github.com/yctimlin/mcp_excalidraw#readme). Point any of those configs at this fork's `dist/index.js` and set `CANVAS_ID` to target a specific canvas.
