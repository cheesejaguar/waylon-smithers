# PRD: **waylon-smithers** — persistent, unattended iteration loops for Codex CLI

**Doc type:** Product Requirements Document (PRD)  
**Project name:** `waylon-smithers`  
**Target platform:** OpenAI **Codex CLI** (local / terminal)  
**Inspiration:** Claude Code’s `ralph-wiggum` plugin (stop-hook + completion promise + max iterations)  
**Last updated:** 2026-01-06

---

## 1) Summary

`waylon-smithers` is a small, “dutiful butler” wrapper around **Codex CLI non-interactive mode** that:

- runs a task prompt **repeatedly** using `codex exec`,
- **resumes** the same Codex exec session between iterations,
- stops only when:
  - a configured **completion promise** appears in Codex’s final message, or
  - a **max iteration** safety cap is reached, or
  - the user cancels, or
  - an optional **HARD STOP** checkpoint is reached (pause for human review).

The goal: replicate the *workflow outcome* of Claude’s Ralph loop (keep going until done) using Codex-native automation primitives (`codex exec`, JSONL events, output capture, resume).

---

## 2) Problem statement

### What users do today
Developers often need 5–50+ agent passes to complete real work:

- implement a change
- run tests / lint
- fix failures
- refactor
- re-test

With Codex CLI, this frequently becomes **manual babysitting**: rerun / continue / re-prompt / resume.

### Why this is painful
- Long refactors and “get tests green” work stalls when the developer walks away.
- Manual “continue” prompting is repetitive and error-prone.
- Without guardrails, naive loops can burn time and tokens.

### What we’re copying from the Ralph pattern
The Ralph method is “re-feed the same prompt until a stop condition hits,” with:
- a **completion promise** (“only print this when truly done”),
- and a **max-iterations** cap for safety.

---

## 3) Goals & non-goals

### Goals (v1)
1. **One-command unattended loops** for Codex CLI.
2. **Deterministic completion detection** via a completion promise tag or regex.
3. **Stateful and resumable** after interruption (Ctrl+C, laptop sleep, etc.).
4. **Safe by default**: conservative iteration cap + conservative sandbox/approval defaults.
5. **Multi-loop support**: multiple loops can run in the same repo without clobbering state.
6. **Observable**: iteration logs, last-message capture, optional JSON summaries.

### Non-goals (v1)
- Modifying Codex’s interactive TUI or intercepting its exit behavior. (Codex doesn’t expose an “exit hook” like Claude’s stop-hook; we loop externally via `codex exec` + resume.)
- Cloud scheduling / background daemons / hosted services.
- Enforcement of hard dollar budgets (token/cost reporting is OK).

---

## 4) Personas

1. **Solo developer**: wants to grind through a checklist and wake up to a working branch.
2. **Tech lead**: wants Codex to iterate with periodic “HARD STOP” checkpoints.
3. **CI / automation engineer**: wants “fix until tests pass” loops on a runner.

---

## 5) User stories

- As a developer, I can run one command that iterates until the task is complete.
- As a developer, I can cap the loop at N iterations to prevent runaway behavior.
- As a developer, I can pause at “HARD STOP” checkpoints for human review.
- As a developer, I can resume a previously interrupted loop without losing progress.
- As a developer, I can cancel the loop and keep the repo intact.

---

## 6) Product concept

### What we’re building
A “plugin-like” bundle for Codex CLI consisting of:

**A) Wrapper executable**
- `waylon-smithers` (primary CLI)

**B) Optional Codex UX helpers**
- a **Custom Prompt** (slash-command style) installer so users can quickly insert the “Smithers loop” prompt scaffolding inside Codex sessions.
- an optional **Skill** (`$waylon-smithers` / `$smithers-loop`) that codifies best practices (promise discipline, checkpoints, safe defaults, etc.).

> Note: custom prompts and skills don’t provide executable “hooks.” They’re instruction bundles.
> The *actual looping* is done by the wrapper using `codex exec` + resume.

---

## 7) UX / CLI spec

### Primary command

```bash
waylon-smithers "<PROMPT>" [options]
```

#### Core options
- `--max-iterations <N>`
  - Default: `30`
- `--completion-promise <TEXT>`
  - Default: `TASK_COMPLETE`
- `--promise-mode <tag|plain|regex>`
  - Default: `tag`
  - `tag` expects: `<promise>TEXT</promise>`
- `--loop-id <ID>`
  - Default: derived from repo name + timestamp
- `--state-file <PATH>`
  - Default: `.codex/waylon-smithers/loops/<loop-id>.json`

#### Codex exec controls (pass-through / wrapper-managed defaults)
- `--cd <PATH>` set workspace root
- `--model <MODEL>` override model
- `--profile <PROFILE>` select config profile
- `--sandbox <read-only|workspace-write|danger-full-access>`
- `--full-auto` convenience preset (maps to Codex’s low-friction automation preset)
- `--ask-for-approval <untrusted|on-failure|on-request|never>`
- `--skip-git-repo-check`

#### Output / logging
- `--jsonl-events <PATH>`
  - Saves the JSON Lines stream for each iteration (wrapper captures `codex exec --json` output).
- `--last-message-dir <PATH>`
  - Default: `.codex/waylon-smithers/loops/<loop-id>/`
- `--summary-json <PATH>`
  - Writes a single JSON file with per-iteration metadata.

#### Checkpoints (optional)
- `--todo-file <PATH>`
- `--hard-stop-token <STRING>` default: `HARD STOP`
- `--hard-stop-mode <pause|exit>` default: `pause`

### Utility subcommands (v1)
- `waylon-smithers status --loop-id <ID>`
- `waylon-smithers cancel --loop-id <ID> [--cleanup-artifacts]`
- `waylon-smithers resume --loop-id <ID>` (sugar for “read state, resume session, continue loop”)

---

## 8) Functional requirements

### FR1 — Iteration engine (Codex exec loop)
- Iteration 1 runs `codex exec` with the wrapper-generated prompt template.
- Subsequent iterations run `codex exec resume <SESSION_ID>` (or `--last` when appropriate), optionally with a small follow-up prompt to “continue the Smithers loop.”

### FR2 — Capture final message deterministically
- Use Codex’s `--output-last-message <path>` each iteration to capture the assistant’s final message.
- Optionally also capture `--json` JSONL events for richer telemetry and debugging.

### FR3 — Completion detection
- If promise mode is `tag`, detect exact substring:
  - `<promise>{completion_promise}</promise>`
- If promise mode is `plain`, detect:
  - `{completion_promise}`
- If promise mode is `regex`, evaluate user-provided regex against the last message text.
- When detected:
  - mark loop complete
  - stop iterating
  - write a completion summary

### FR4 — Max iteration safety
- Enforce `max_iterations`. When reached:
  - stop the loop
  - mark state as `stopped_max_iterations`
  - write a summary including “what to do next” (e.g., rerun with higher cap, adjust prompt, add tests, etc.)

### FR5 — Persistent, resumable state
- State is written:
  - at initialization
  - after each iteration completes
  - on pause/cancel/finish
- State includes:
  - session id
  - iteration count
  - prompt
  - completion promise config
  - paths to artifacts

### FR6 — Multiple concurrent loops
- Each loop has a unique `loop-id` and state file; artifacts stored in a dedicated loop directory.

### FR7 — HARD STOP checkpoints (optional)
If `--todo-file` is set:
- After each iteration, scan TODO.md for the hard stop token.
- If found and `hard_stop_mode=pause`:
  - pause the loop and require user confirmation to continue.
- If `hard_stop_mode=exit`:
  - stop immediately and mark state as `paused_hard_stop`.

### FR8 — Cancel & interrupt handling
- Ctrl+C:
  - update state to `paused_user_interrupt`
  - keep session id for future resume
- `waylon-smithers cancel`:
  - mark loop canceled
  - optional cleanup deletes wrapper artifacts only (never deletes repo files)

---

## 9) State file format (v1)

Default path: `.codex/waylon-smithers/loops/<loop-id>.json`

```json
{
  "loop_id": "repo-2026-01-06T21-10-00",
  "created_at": "2026-01-06T21:10:00-08:00",
  "workspace_root": "/path/to/repo",
  "prompt": "Go through TODO.md step-by-step...",
  "completion_promise": "DONE",
  "promise_mode": "tag",
  "max_iterations": 50,
  "iteration": 7,
  "status": "running",
  "codex": {
    "session_id": "0199a213-81c0-7800-8aa1-bbab2a035a53",
    "model": "gpt-5.2-codex",
    "sandbox": "workspace-write",
    "approval": "on-request",
    "profile": "default"
  },
  "todo": {
    "path": "TODO.md",
    "hard_stop_token": "HARD STOP",
    "hard_stop_mode": "pause",
    "paused_for_hard_stop": false
  },
  "artifacts": {
    "dir": ".codex/waylon-smithers/loops/repo-2026-01-06T21-10-00/",
    "last_message_path": "last_message_iter_7.txt",
    "jsonl_path": "events_iter_7.jsonl",
    "summary_json_path": "summary.json"
  },
  "last_result": {
    "exit_code": 0,
    "detected_promise": false
  }
}
```

---

## 10) Prompt template (wrapper-generated)

Each iteration sends Codex a wrapper prompt built from:

1. **Header**
   - loop id, iteration number, max iterations
   - promise mode and exact promise token
2. **Task**
   - user-provided prompt verbatim
3. **Rules**
   - Only output the completion promise when the task is *completely and unequivocally done*.
   - If blocked, output a structured “BLOCKED” section and propose next steps.
4. **Optional TODO workflow**
   - “Work top-to-bottom”
   - “Stop at HARD STOP and request human review”
   - “Prefer deterministic checks: tests, linters, typecheck”

Example promise discipline rule (tag mode):

```text
You MUST output the exact string: <promise>DONE</promise> ONLY when all requirements are satisfied and verification passes.
Otherwise, do not output that string.
```

---

## 11) Safety, security, and policy defaults

### Defaults
- `--sandbox read-only` by default (safer)
- approvals default to `on-request` (unless user config overrides)
- `--full-auto` is opt-in (maps to Codex’s “low-friction automation preset”)

### Explicit “danger” mode
- Never enable `danger-full-access` or “bypass approvals” without explicit flags.
- If the user enables dangerous settings, the tool must print a big warning banner.

---

## 12) Metrics / success criteria

### Product metrics
- Completion rate before max-iterations
- Median iterations-to-complete
- Human interruptions per completed loop (lower is better)

### Engineering metrics
- Resume success rate after interruption
- State corruption incidents (target: 0)
- False-positive completion detections (target: 0)

---

## 13) Acceptance criteria (must-pass)

1. `waylon-smithers` performs 3+ iterations using a single Codex exec session (resume between iterations).
2. Completion promise detection stops the loop immediately and marks state `completed`.
3. Max-iterations stops the loop and marks state `stopped_max_iterations`.
4. Two loops can run without state collisions.
5. HARD STOP pauses and requires user confirmation to proceed.
6. Ctrl+C leaves a resumable state with session id intact.

---

## 14) Rollout plan

### Phase 0 — Prototype
- Minimal flags: prompt, max-iterations, completion-promise
- Use `--output-last-message` for deterministic capture
- Use `codex exec resume` for iteration continuity

### Phase 1 — Polished UX
- Add `status`, `cancel`, `resume`
- Add artifact folders and summary JSON

### Phase 2 — Optional Codex helpers
- Installer that writes:
  - `~/.codex/prompts/waylon-smithers.md` (custom prompt)
  - `.codex/skills/waylon-smithers/SKILL.md` (repo-shared skill)

---

## 15) Risks & open questions

- Session growth: very long loops may accumulate context; mitigation is to rely on repo files, concise iteration instructions, and periodic “summarize state to file” steps.
- “Promise discipline” is only as good as the prompt; v1 should ship with strong templates and examples.
- Some tasks need human judgment; HARD STOP is the escape hatch.

---

## 16) Appendix: Example usage

### Basic loop
```bash
waylon-smithers \
  "Go through TODO.md step-by-step. Ensure tests pass. Output <promise>DONE</promise> only when complete." \
  --completion-promise DONE \
  --max-iterations 50 \
  --todo-file TODO.md
```

### Resume a loop
```bash
waylon-smithers resume --loop-id repo-2026-01-06T21-10-00
```

### Low-friction automation preset (opt-in)
```bash
waylon-smithers \
  "Fix failing tests until green. Output <promise>DONE</promise> when all tests pass." \
  --completion-promise DONE \
  --max-iterations 25 \
  --full-auto
```

---

## References (for implementers)

```text
Claude Code ralph-wiggum README:
https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum

Codex CLI reference (flags, exec resume, output-last-message, json):
https://developers.openai.com/codex/cli/reference/

Codex non-interactive mode (JSONL stream semantics):
https://developers.openai.com/codex/noninteractive/

Codex custom prompts (slash-command style prompts from ~/.codex/prompts):
https://developers.openai.com/codex/custom-prompts/

Codex agent skills (SKILL.md structure, invocation model):
https://developers.openai.com/codex/skills/
```
