# waylon-smithers

Dutiful Codex CLI loop wrapper inspired by the Ralph Wiggum pattern. Runs `codex exec` repeatedly, resumes the same session between iterations, and stops on a completion promise, HARD STOP marker, max-iteration cap, or user cancel.

## Quick start

```bash
npm install
npx waylon-smithers \
  "Go through TODO.md step-by-step. Output <promise>DONE</promise> only when complete." \
  --completion-promise DONE \
  --max-iterations 30 \
  --todo-file TODO.md
```

What happens each iteration:
- iteration 1 runs `codex exec "<prompt>" --json --output-last-message <file>`
- subsequent iterations run `codex exec resume <session-id> "<continue prompt>"` with the same session
- last messages are captured to `.codex/waylon-smithers/loops/<loop-id>/last_message_iter_<n>.txt`
- state persists in `.codex/waylon-smithers/loops/<loop-id>.json` so you can resume later

## Primary command

```bash
waylon-smithers "<PROMPT>" [options]
```

Core loop options:
- `--max-iterations <n>` (default `30`)
- `--completion-promise <text>` (default `TASK_COMPLETE`)
- `--promise-mode <tag|plain|regex>` (default `tag`; tag looks for `<promise>TEXT</promise>`)
- `--loop-id <id>` (default repo-name + timestamp)
- `--state-file <path>` override state location (default `.codex/waylon-smithers/loops/<loop-id>.json`)

Codex exec pass-through (safe defaults baked in):
- `--model <model>`, `--profile <name>`
- `--sandbox <policy>` (default `read-only`; `--full-auto` sets workspace-write)
- `--ask-for-approval <policy>` (default `on-request`; `--full-auto` sets `on-request`)
- `--full-auto`, `--skip-git-repo-check`, `--cd <path>`

Artifacts and observability:
- `--jsonl-events <path>` save newline-delimited JSON events per iteration
- `--last-message-dir <path>` override where last messages are stored (default per-loop dir)
- `--summary-json <path>` write a rolling summary JSON (default per-loop dir)
- Smithers always runs `codex exec` with `--json` to capture session ids; use `--jsonl-events` to persist the stream

Checkpoints:
- `--todo-file <path>` scan after each iteration
- `--hard-stop-token <text>` (default `HARD STOP`)
- `--hard-stop-mode <pause|exit>` (default `pause`; asks for confirmation before continuing)

## Utility commands

- `waylon-smithers status --loop-id <id>` — dump the current state JSON
- `waylon-smithers resume --loop-id <id> [overrides]` — continue a saved loop, optionally overriding max iterations, promise, or logging paths
- `waylon-smithers cancel --loop-id <id> [--cleanup-artifacts]` — mark canceled and optionally delete loop artifacts (never touches repo files)
- `waylon-smithers install-helpers` — install a custom prompt (`~/.codex/prompts/waylon-smithers.md`) and skill (`~/.codex/skills/waylon-smithers/SKILL.md`)

## Completion detection

Promise modes use the last message from each iteration:
- `tag` (default): looks for `<promise>TEXT</promise>`
- `plain`: plain substring match on the provided promise
- `regex`: treats the promise as a regular expression

When a promise is detected, the loop stops and marks the state as `completed`. Hitting `--max-iterations` marks `stopped_max_iterations`. HARD STOP tokens mark `paused_hard_stop` and, in pause mode, prompt for human confirmation.

## Safety defaults

- Sandbox defaults to `read-only`; approvals default to `on-request`
- Dangerous settings (`--sandbox danger-full-access` or `--ask-for-approval never`) print a warning banner
- Ctrl+C saves state as `paused_user_interrupt` so you can resume

## Layout

- State: `.codex/waylon-smithers/loops/<loop-id>.json`
- Artifacts: `.codex/waylon-smithers/loops/<loop-id>/`
  - `last_message_iter_<n>.txt`
  - `events_iter_<n>.jsonl` (when `--jsonl-events` is set)
  - `summary.json`

## Inspiration

Based on the Ralph Wiggum loop pattern used in Claude Code (`plugins/ralph-wiggum`), adapted for Codex CLI non-interactive mode and session resume support.
