# Excalidraw MCP Server

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Live Excalidraw canvas controlled by AI agents via MCP tools. Draw, inspect, iterate, export — all programmatically.

> Fork of [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) with multi-canvas support, shared server architecture, and `mcp-call` integration.

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
Canvas:   http://localhost:59189/?canvasId=canvas-abc123
Canvases: http://localhost:59189/canvases
MCP:      mcp-call excalidraw-canvas-abc123 <tool> ...
```

Open the canvas URL in your browser. Use `mcp-call` to interact.

## Architecture

```
Claude Session 1 ─┐
Claude Session 2 ──┤── launch.sh ──→ Shared Express Server (1 port) ──→ Canvas A
Claude Session 3 ──┘         ↓                    ├──→ Canvas B
                     reuses if running             ├──→ Canvas C
                                                   └──→ /canvases dashboard
```

- **Shared server** — one process, one port, no zombie processes
- **Multi-canvas** — each session gets its own isolated canvas (`?canvasId=...`)
- **Auto-open browser** — screenshot/viewport tools auto-open browser if no tab connected
- **mcp-call** — stateless MCP proxy spawned per call, canvas state lives in Express server

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

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Canvas server port | `3000` (launch.sh picks random) |
| `EXPRESS_SERVER_URL` | Canvas server URL (for MCP) | `http://localhost:3000` |
| `CANVAS_ID` | Canvas to use | `default` |
| `ENABLE_CANVAS_SYNC` | Sync MCP to canvas | `true` |

## Testing

```bash
npm test              # 94 unit + integration tests (vitest)
npm run build         # TypeScript + frontend build
```

## Development

```
src/
├── server.ts              # Express entry (105 lines)
├── index.ts               # MCP server entry (104 lines)
├── routes/                # Express route handlers
│   ├── elements.ts        # CRUD + batch + sync
│   ├── canvases.ts        # Multi-canvas management
│   ├── export.ts          # Screenshot + viewport
│   ├── history.ts         # Undo/redo
│   ├── snapshots.ts       # Save/restore state
│   └── files.ts           # Image file storage
├── tools/                 # MCP tool layer
│   ├── definitions.ts     # 30 tool schemas
│   ├── handlers.ts        # Tool handler switch
│   └── sync.ts            # Canvas sync helpers
├── schemas.ts             # Zod validation
├── helpers.ts             # Shared utilities
├── websocket.ts           # WS broadcast + clients
├── diagram-guide.ts       # Design guide content
├── types.ts               # Types + canvas state
└── __tests__/             # 94 tests
```
