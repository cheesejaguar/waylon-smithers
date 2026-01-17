# 🤖 waylon-smithers

Dutiful Codex CLI loop wrapper inspired by the Ralph Wiggum pattern. Runs `codex exec` repeatedly, resumes the same session between iterations, and stops on a completion promise, HARD STOP marker, max-iteration cap, or user cancel.

## 🚀 Quick start

```bash
npm install
npx waylon-smithers \
  "Go through TODO.md step-by-step. Output <promise>DONE</promise> only when complete." \
  --completion-promise DONE \
  --max-iterations 30 \
  --todo-file TODO.md
```

## 🔄 Ralph Wiggum mode

Use `--same-prompt-each-iteration` to replicate the original Ralph Wiggum pattern where the same full prompt is used every iteration (file state changes, but the prompt doesn't):

```bash
npx waylon-smithers \
  "Build a REST API. Output <promise>COMPLETE</promise> when all tests pass." \
  --completion-promise COMPLETE \
  --max-iterations 50 \
  --same-prompt-each-iteration
```

## 💡 Philosophy (Ralph Wiggum pattern)

This tool implements the Ralph Wiggum iteration pattern:

- **Iteration > Perfection**: Don't aim for perfect on first try. Let the loop refine your work.
- **Failures Are Data**: Test/lint failures inform the next iteration. "Deterministically bad" is useful.
- **Self-Referential Feedback**: The agent reads its own previous work in files and git history.
- **Persistence Wins**: Keep trying until success. The loop handles retry logic automatically.
- **Operator Skill Matters**: Success depends on writing good prompts, not just having a good model.

## ⚙️ How it works

Each iteration:
- Iteration 1 runs `codex exec "<prompt>" --json --output-last-message <file>`
- Subsequent iterations run `codex exec resume <session-id> "<prompt>"` with the same session
- Last messages are captured to `.codex/waylon-smithers/loops/<loop-id>/last_message_iter_<n>.txt`
- State persists in `.codex/waylon-smithers/loops/<loop-id>.json` so you can resume later

## 📋 Primary command

```bash
waylon-smithers "<PROMPT>" [options]
```

### Core loop options

| Option | Default | Description |
|--------|---------|-------------|
| `--max-iterations <n>` | `30` | Maximum iterations before stopping |
| `--completion-promise <text>` | `TASK_COMPLETE` | Token that signals completion |
| `--promise-mode <tag\|plain\|regex>` | `tag` | Detection mode; `tag` looks for `<promise>TEXT</promise>` |
| `--same-prompt-each-iteration` | `false` | Use full prompt every iteration (Ralph Wiggum mode) |
| `--loop-id <id>` | auto | Loop identifier (defaults to repo-name + timestamp) |
| `--state-file <path>` | auto | Override state location |

### Codex exec pass-through (safe defaults baked in)

| Option | Default | Description |
|--------|---------|-------------|
| `--model <model>` | - | Codex model |
| `--profile <name>` | - | Codex profile |
| `--sandbox <policy>` | `read-only` | Sandbox policy; `--full-auto` sets `workspace-write` |
| `--ask-for-approval <policy>` | `on-request` | Approval mode |
| `--full-auto` | `false` | Enable Codex low-friction preset |
| `--skip-git-repo-check` | `false` | Skip git repo detection |
| `--cd <path>` | cwd | Workspace root |

### Artifacts and observability

| Option | Default | Description |
|--------|---------|-------------|
| `--jsonl-events <path>` | - | Save newline-delimited JSON events per iteration |
| `--last-message-dir <path>` | per-loop dir | Override where last messages are stored |
| `--summary-json <path>` | per-loop dir | Write a rolling summary JSON |

### 🛑 Checkpoints

| Option | Default | Description |
|--------|---------|-------------|
| `--todo-file <path>` | - | Scan after each iteration |
| `--hard-stop-token <text>` | `HARD STOP` | Token that triggers pause |
| `--hard-stop-mode <pause\|exit>` | `pause` | Behavior when HARD STOP found |

## 🔧 Utility commands

- `waylon-smithers list [--cd <path>] [--json]` — list all loops in the workspace
- `waylon-smithers status --loop-id <id>` — dump the current state JSON
- `waylon-smithers resume --loop-id <id> [overrides]` — continue a saved loop
- `waylon-smithers cancel --loop-id <id> [--cleanup-artifacts]` — mark canceled and optionally delete loop artifacts
- `waylon-smithers install-helpers` — install custom prompt and skill helpers

## ✍️ Prompt writing best practices

### 1. Clear completion criteria

❌ Bad:
```
Build a todo API and make it good.
```

✅ Good:
```
Build a REST API for todos.

When complete:
- All CRUD endpoints working
- Input validation in place
- Tests passing (coverage > 80%)
- README with API docs
- Output: <promise>COMPLETE</promise>
```

### 2. Incremental goals

❌ Bad:
```
Create a complete e-commerce platform.
```

✅ Good:
```
Phase 1: User authentication (JWT, tests)
Phase 2: Product catalog (list/search, tests)
Phase 3: Shopping cart (add/remove, tests)

Output <promise>COMPLETE</promise> when all phases done.
```

### 3. Self-correction loops

❌ Bad:
```
Write code for feature X.
```

✅ Good:
```
Implement feature X following TDD:
1. Write failing tests
2. Implement feature
3. Run tests
4. If any fail, debug and fix
5. Refactor if needed
6. Repeat until all green
7. Output: <promise>COMPLETE</promise>
```

### 4. Escape hatches

Always set a reasonable `--max-iterations` as a safety net:

```bash
# Recommended: Always set a reasonable iteration limit
waylon-smithers "Try to implement feature X" --max-iterations 20
```

In your prompt, include what to do if stuck:
```
After 15 iterations, if not complete:
- Document what's blocking progress
- List what was attempted
- Suggest alternative approaches
```

## ✅ When to use

**Good for:**
- Well-defined tasks with clear success criteria
- Tasks requiring iteration and refinement (e.g., getting tests to pass)
- Greenfield projects where you can walk away
- Tasks with automatic verification (tests, linters)

**Not good for:**
- Tasks requiring human judgment or design decisions
- One-shot operations
- Tasks with unclear success criteria
- Production debugging (use targeted debugging instead)

## 🎯 Completion detection

Promise modes use the last message from each iteration:
- `tag` (default): looks for `<promise>TEXT</promise>`
- `plain`: plain substring match on the provided promise
- `regex`: treats the promise as a regular expression

When a promise is detected, the loop stops and marks the state as `completed`. Hitting `--max-iterations` marks `stopped_max_iterations`. HARD STOP tokens mark `paused_hard_stop` and, in pause mode, prompt for human confirmation.

## 🔒 Safety defaults

- Sandbox defaults to `read-only`; approvals default to `on-request`
- Dangerous settings (`--sandbox danger-full-access` or `--ask-for-approval never`) print a warning banner
- Ctrl+C saves state as `paused_user_interrupt` so you can resume

## 📁 Layout

- State: `.codex/waylon-smithers/loops/<loop-id>.json`
- Artifacts: `.codex/waylon-smithers/loops/<loop-id>/`
  - `last_message_iter_<n>.txt`
  - `events_iter_<n>.jsonl` (when `--jsonl-events` is set)
  - `summary.json`

## 📚 Examples

### Basic test fixation loop

```bash
waylon-smithers \
  "Run tests and fix all failures. Output <promise>DONE</promise> when all tests pass." \
  --completion-promise DONE \
  --max-iterations 25 \
  --full-auto
```

### Low-friction automation

```bash
waylon-smithers \
  "Fix failing tests until green. Output <promise>DONE</promise> when all tests pass." \
  --completion-promise DONE \
  --max-iterations 25 \
  --full-auto
```

### With HARD STOP checkpoints

```bash
waylon-smithers \
  "Go through TODO.md. Stop at HARD STOP for review. Output <promise>COMPLETE</promise> when done." \
  --completion-promise COMPLETE \
  --max-iterations 50 \
  --todo-file TODO.md \
  --hard-stop-token "HARD STOP" \
  --hard-stop-mode pause
```

### Ralph Wiggum mode (same prompt each iteration)

```bash
waylon-smithers \
  "Build feature X with tests. Output <promise>DONE</promise> when complete." \
  --completion-promise DONE \
  --max-iterations 30 \
  --same-prompt-each-iteration
```

## 🙏 Inspiration

Based on the Ralph Wiggum loop pattern used in Claude Code (`plugins/ralph-wiggum`), adapted for Codex CLI non-interactive mode and session resume support.

Key insight from Ralph: "The prompt never changes between iterations; only the file state changes as the agent autonomously improves based on previous work."

## 📖 References

- [Ralph Wiggum technique](https://ghuntley.com/ralph/)
- [Claude Code ralph-wiggum plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)
