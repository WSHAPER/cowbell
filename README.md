<div align="center">

# cowbell

**Drive [herdr](https://github.com/herdrdev/herdr) fleets from any AI agent.**

Properly typed MCP tools for terminal workspace, pane, and agent control.

[![CI](https://github.com/WSHAPER/cowbell/actions/workflows/ci.yml/badge.svg)](https://github.com/WSHAPER/cowbell/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-green.svg)](#requirements)
[![herdr](https://img.shields.io/badge/herdr-0.9.5-orange.svg)](#requirements)

</div>

---

## Why

AI agents don't stick to prose protocols. You can write a detailed playbook for driving a terminal multiplexer, but the agent will improvise. Reviewing shell calls in agent output is error-prone: the agent's native language is tool calls, not command strings.

cowbell exposes [herdr](https://github.com/herdrdev/herdr)'s workspace, pane, and agent operations as typed MCP tools with schemas the agent can discover and self-check against. Instead of hoping the agent constructs the right `herdr agent prompt --until idle --timeout 90000 target "text"` invocation, it calls a tool with named parameters, validated before execution.

When the CLI underneath changes, the drift tripwire names the exact break instead of your fleet silently dying.

## Quick start

```bash
git clone https://github.com/WSHAPER/cowbell.git
cd cowbell
npm install
npm test
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "cowbell": {
      "command": "npx",
      "args": ["tsx", "src/bin/stdio.ts"],
      "cwd": "/path/to/cowbell"
    }
  }
}
```

## Tools

### Workspaces

| Tool               | Description                               |
| ------------------ | ----------------------------------------- |
| `workspace_list`   | List herdr workspaces                     |
| `workspace_get`    | Show one workspace                        |
| `workspace_create` | Create a workspace, returns the root pane |
| `workspace_close`  | Close a workspace                         |
| `workspace_focus`  | Focus a workspace                         |

### Panes

| Tool             | Description                    |
| ---------------- | ------------------------------ |
| `pane_get`       | Get pane details               |
| `pane_read`      | Read terminal output           |
| `pane_send_text` | Type text without Enter        |
| `pane_send_keys` | Send key presses               |
| `pane_run`       | Type a command and press Enter |

### Agents

| Tool             | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `agent_list`     | List recognized agents                                       |
| `agent_get`      | Show one agent                                               |
| `agent_read`     | Read agent terminal output (pane view)                       |
| `agent_messages` | Read an agent's structured transcript (channel-labeled)      |
| `agent_prompt`   | Submit a prompt (types + Enter; `deliver_when: now \| idle`) |
| `agent_wait`     | Block until a status                                         |
| `agent_start`    | Start an agent in an existing pane (`model` or `args`)       |
| `agent_focus`    | Focus an agent pane                                          |
| `agent_rename`   | Rename an agent                                              |
| `models_list`    | List local opencode models, default marked (discovery)       |

Every herdr-backed tool accepts optional `machine` or `remote` parameters (mutually exclusive). Without them, commands run against your local herdr session. Remote workspaces and agents are invisible in the local UI, so callers opt in per call. `models_list` is the one exception: it queries the local opencode API, where transport params do not apply, so it takes no parameters at all.

## Transcript view vs pane view

Two ways to read an agent, two different questions:

- **`agent_messages` — the transcript view.** Resolves the target through `herdr agent get`; recognized agents carry an `agent_session{source, agent, kind, value}` reference (native opencode `ses_...` ids). For opencode sessions it queries the local opencode background-service HTTP API (`opencode api` handles discovery + auth) and returns a validated, normalized transcript: user/assistant turns with texts, reasoning, tool name + status, plus event entries (`system`, `synthetic`, `idle`, `agent-switched`, ...). Every result carries an explicit `channel` field:
  - `channel: "structured"` — read from the native session API.
  - `channel: "pane_fallback"` — no native session available (pane-level agent), a non-opencode session, a `machine`/`remote` transport, or the API was unreachable; the result says why in `reason` and carries the pane text instead. Pane scraping here is a deliberate keep, not an accident.
- **`agent_read` — the pane view.** The raw terminal: spinner frames, blocked-state prompts, exactly what is on screen right now. This is what you want for UI-state questions ("is it showing a permission prompt?"); the transcript is what you want for "what has it said/done?"

## Queue-of-one prompt delivery

`agent_prompt` accepts `deliver_when`:

- `"now"` (default) — submit immediately; `wait`/`until`/`timeout_ms` behave as one `herdr agent prompt` call.
- `"idle"` — first blocks on `herdr agent wait --until idle` (event-driven; `timeout_ms` guards that wait), then submits, so the text lands as the agent's next input. Exactly two calls, no general queue, no persisted state, no daemon — cowbell stays a stateless validated wrapper. Combining `"idle"` with `wait`/`until` is a validation error (the flow already owns the waiting).

## Model selection: typed at start, discovered read-only

`agent_start` accepts `model` — a non-empty selector like `zai/glm-5.3` (optional `#variant` suffix) — compiled internally to `-- -m <model>` after `--` in the herdr argv. herdr's argv stays authoritative; cowbell never invents flags. `model` and `args` are mutually exclusive (a validation error, no silent precedence): use `model` for the common case, `args` when you need full control of the agent binary's argv. The value is NOT checked against a live model list at start time — spawn stays offline-safe.

Discovery is the separate, read-only tool: `models_list` queries the local opencode background service (`GET /api/model` + `GET /api/model/default` via the `opencode api` CLI, which handles discovery + auth) and returns

```json
{
  "models": [
    {
      "model": "zai/glm-5.3",
      "provider": "zai",
      "name": "GLM-5.3",
      "variants": ["low", "high", "max"],
      "default": true
    }
  ],
  "default": "zai/glm-5.3"
}
```

The `model` field is exactly the string `agent_start` wants (and `opencode -m` accepts); the default is returned at the top level and flagged on its entry (null when nothing is configured). No routing, no pool economy — just typed selection plus honest discovery.

## Drift detection

```
src/herdr/spec*.ts              every herdr command, single source (split by domain)
tests/fixtures/herdr-surface.txt     captured --help output
tests/upstream.drift.test.ts         cross-checks spec vs fixture

src/opencode/spec.ts            every opencode api call, single source
tests/fixtures/opencode-session-message.json   captured operation
tests/fixtures/opencode-models.json            captured model.list + model.default
tests/opencode.drift.test.ts         cross-checks spec vs fixture
tests/opencode.models.drift.test.ts  cross-checks model surface vs fixture
```

When herdr renames a flag or subcommand:

```bash
npm run reference:update    # pull upstream source
npm run reference:surface   # re-capture --help tree
npm test                    # names the exact broken builder
```

When opencode renames the message operation, its parameters, or the
message/part type unions:

```bash
bash scripts/dump-opencode-surface.sh   # re-capture the operation
npm test                                # names the exact token
```

When opencode renames the model operations (`model.list`,
`model.default`) or drops a `Model.Info` key the models view pins:

```bash
npm run reference:opencode-models       # re-capture both operations
npm test                                # names the exact token
```

## Requirements

- Node.js >= 22
- [herdr](https://github.com/herdrdev/herdr) >= 0.9.5 on PATH (for local tools) or reachable via SSH (for remote tools)

## Development

```bash
npm run build          # compile to dist/
npm run typecheck      # tsc --noEmit
npm run lint           # eslint (typechecked)
npm run test           # vitest
npm run e2e            # full loop against live herdr
npm run bench          # e2e + hyperfine
```

## License

[MIT](LICENSE)
