# cowbell playbook

The manual verification guide. Run this when something smells and you want eyes on the herdr UI while the loop runs.

## Daily loop

```bash
npm run reference:update      # pull upstream herdr source
npm run reference:surface     # re-capture the --help fixture
npm test                      # drift suite names any breakage
npm run e2e                   # real loop vs the live session
```

## When the drift suite fails

1. Read the failure: it names the tool and the missing token.
2. Run `npm run reference:surface`.
3. Update the builder in the matching `src/herdr/spec-*.ts` (or `transport-args.ts`) to the new grammar.
4. Update the argv pin in `tests/herdr.spec.test.ts`.
5. Run `npm test` until green. The pin diff is the review artifact.

## Transport rules

No params means the local herdr session (always the default). Pass `machine: "<label>"` to run on a registered machine, or `remote: "<ssh target>"` for a remote herdr session. Both at once is a validation error.

## Structured transcripts (agent_messages)

`agent_messages` reads the transcript view; `agent_read` reads the pane view (spinner/blocked states). To eyeball the structured channel live:

1. `herdr agent list` — find an agent whose entry has an `agent_session` (`"agent": "opencode", "kind": "id"`, a `ses_...` value).
2. Call `agent_messages` on that pane — expect `channel: "structured"` and normalized turns.
3. Call it on a pane-level agent (no `agent_session`) — expect `channel: "pane_fallback"` with a `reason`.

When opencode's API drifts, `npm run reference:opencode` re-captures the operation fixture and the drift suite names the token. Same for the model surface: `npm run reference:opencode-models`.

## Model selection (agent_start model + models_list)

`agent_start`'s `model` param compiles per kind after `--` (`mini -m` for opencode — the full TUI has no model flag; `-m` for other kinds; exclusive with `args`, never validated against a live list — spawn stays offline-safe, unknown selectors fail only when first used). To eyeball discovery live:

1. Call `models_list` — expect `default` at the top level and flagged on exactly one entry.
2. Pick a selector from the result and start an agent with it — `herdr agent start` argv shows `-- -m <selector>` in the e2e log.

## Devcontainer

`.devcontainer/` boots Node 22, tmux, herdr, and hyperfine. The post-create hook runs every gate, the e2e loop, and the bench.
