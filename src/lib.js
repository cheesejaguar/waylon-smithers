const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const DEFAULT_MAX_ITERATIONS = 30;
const DEFAULT_COMPLETION_PROMISE = "TASK_COMPLETE";
const DEFAULT_PROMISE_MODE = "tag";
const DEFAULT_SANDBOX = "read-only";
const DEFAULT_APPROVAL = "on-request";
const DEFAULT_HARD_STOP_TOKEN = "HARD STOP";
const DEFAULT_HARD_STOP_MODE = "pause";
const DEFAULT_SAME_PROMPT_EACH_ITERATION = false;

let currentChild = null;
let sigintReceived = false;

// Exported for testing
function _setCurrentChild(child) {
  currentChild = child;
}

function _setSigintReceived(value) {
  sigintReceived = value;
}

function _getSigintReceived() {
  return sigintReceived;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultLoopId(workspaceRoot) {
  const name = path.basename(workspaceRoot || process.cwd());
  const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\.\d+Z?$/, "");
  return `${name}-${stamp}`;
}

function ensureDirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function relToWorkspace(absPath, workspaceRoot) {
  const relative = path.relative(workspaceRoot, absPath);
  return relative === "" ? "." : relative;
}

function writeJson(filePath, data) {
  ensureDirFor(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found at ${statePath}`);
  }
  return readJson(statePath);
}

function saveState(state, statePath) {
  state.updated_at = nowIso();
  writeJson(statePath, state);
}

function warnDangerous(options) {
  if (options.sandbox === "danger-full-access" || options.askForApproval === "never") {
    console.warn(
      "[WARN] Running with dangerous settings. Commands may execute without sandbox or approvals."
    );
  }
}

function buildPromptTemplate({
  loopId,
  iteration,
  maxIterations,
  promiseMode,
  completionPromise,
  userPrompt,
  todoFile,
  hardStopToken,
}) {
  const promiseText =
    promiseMode === "tag"
      ? `<promise>${completionPromise}</promise>`
      : promiseMode === "plain"
        ? completionPromise
        : `Regex: ${completionPromise}`;

  const promiseRule =
    promiseMode === "tag"
      ? `You MUST output the exact string: <promise>${completionPromise}</promise> ONLY when all requirements are satisfied and verification passes.`
      : `You MUST output the completion promise (${promiseText}) ONLY when all requirements are satisfied and verification passes.`;

  const todoRules = todoFile
    ? [
        `If ${hardStopToken} is present in ${todoFile}, stop and request human review before continuing.`,
        "Work through TODO items from top to bottom before moving on.",
      ]
    : [];

  return [
    `Waylon-Smithers loop`,
    `Loop ID: ${loopId}`,
    `Iteration: ${iteration} of ${maxIterations}`,
    `Completion promise (${promiseMode} mode): ${promiseText}`,
    "",
    "Task:",
    userPrompt.trim(),
    "",
    "Iteration philosophy (Ralph Wiggum pattern):",
    "- You have access to your own previous work in the files and git history.",
    "- Each iteration refines the codebase based on what you observe.",
    "- Iteration > perfection: don't aim for perfect on the first try; let the loop refine your work.",
    "- Failures are data: use test/lint failures to inform the next iteration.",
    "- Read your previous output and commit history to understand what has been done.",
    "",
    "Rules:",
    promiseRule,
    "If blocked, output a short BLOCKED section with what is needed to proceed.",
    "Prefer deterministic verification steps (tests, linters, typechecks) before claiming completion.",
    "After verifying, if any check fails, fix the issue and verify again in this same iteration if possible.",
    ...todoRules,
    "",
    "When you are certain the task is complete and all verification passes, output ONLY the completion promise token on its own line.",
  ].join("\n");
}

function buildContinuePrompt({
  loopId,
  iteration,
  maxIterations,
  promiseMode,
  completionPromise,
}) {
  const promiseText =
    promiseMode === "tag" ? `<promise>${completionPromise}</promise>` : completionPromise;
  return [
    `Continue the Waylon-Smithers loop.`,
    `Loop ID: ${loopId}`,
    `Iteration: ${iteration} of ${maxIterations}.`,
    `Remember the completion promise (${promiseMode}): ${promiseText}`,
    `Only output the promise when the task is fully complete and validated.`,
  ].join("\n");
}

function detectCompletion(lastMessage, promiseMode, completionPromise) {
  if (!lastMessage) return false;
  if (promiseMode === "regex") {
    try {
      const re = new RegExp(completionPromise);
      return re.test(lastMessage);
    } catch (err) {
      console.error(`Invalid completion regex: ${err.message}`);
      return false;
    }
  }

  if (promiseMode === "tag") {
    return lastMessage.includes(`<promise>${completionPromise}</promise>`);
  }
  return lastMessage.includes(completionPromise);
}

function checkHardStop(todoPath, token) {
  if (!todoPath) return false;
  if (!fs.existsSync(todoPath)) return false;
  const content = fs.readFileSync(todoPath, "utf8");
  return content.includes(token);
}

function readFileSafe(filePath) {
  if (!filePath) return "";
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function parseSessionIdFromText(text) {
  const candidates = text.split(/\r?\n/);
  for (const line of candidates) {
    const match = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (match) {
      return match[0];
    }
  }
  return null;
}

function parseSessionIdFromJsonLines(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.session_id) return event.session_id;
      if (event.session && typeof event.session === "object" && event.session.id) {
        return event.session.id;
      }
      if (event.id && event.type === "session") return event.id;
    } catch (err) {
      // ignore malformed JSON lines
    }
  }
  return null;
}

function computeJsonlPath(jsonlBase, iteration, workspaceRoot) {
  if (!jsonlBase) return null;
  const resolved = path.resolve(workspaceRoot, jsonlBase);
  if (path.extname(resolved) === ".jsonl") {
    const name = path.basename(resolved, ".jsonl");
    const dir = path.dirname(resolved);
    return path.join(dir, `${name}_iter_${iteration}.jsonl`);
  }
  return path.join(resolved, `events_iter_${iteration}.jsonl`);
}

async function promptYesNo(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) => {
    rl.question(`${message} [y/N]: `, (resp) => resolve(resp.trim().toLowerCase()));
  });
  rl.close();
  return answer === "y" || answer === "yes";
}

function registerSigintHandler(onInterrupt) {
  process.on("SIGINT", () => {
    sigintReceived = true;
    if (currentChild) {
      currentChild.kill("SIGINT");
    }
    if (typeof onInterrupt === "function") {
      onInterrupt();
    }
  });
}

async function runCodexIteration({
  prompt,
  resumeSessionId,
  workspaceRoot,
  lastMessagePath,
  jsonlPath,
  codexOptions,
}) {
  const args = ["exec"];

  if (resumeSessionId) {
    args.push("resume", resumeSessionId);
    if (prompt) {
      args.push(prompt);
    }
  } else {
    args.push(prompt);
  }

  args.push("--output-last-message", lastMessagePath);
  args.push("--json");

  if (codexOptions.cd) {
    args.push("--cd", codexOptions.cd);
  }
  if (codexOptions.model) {
    args.push("--model", codexOptions.model);
  }
  if (codexOptions.profile) {
    args.push("--profile", codexOptions.profile);
  }
  if (codexOptions.sandbox) {
    args.push("--sandbox", codexOptions.sandbox);
  }
  if (codexOptions.askForApproval) {
    args.push("--ask-for-approval", codexOptions.askForApproval);
  }
  if (codexOptions.fullAuto) {
    args.push("--full-auto");
  }
  if (codexOptions.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }

  const options = {
    cwd: workspaceRoot,
    env: process.env,
  };

  const child = spawn("codex", args, options);
  currentChild = child;

  let stdout = "";
  let stderr = "";
  const eventsStream = jsonlPath ? fs.createWriteStream(jsonlPath) : null;

  child.stdout.on("data", (data) => {
    const text = data.toString();
    stdout += text;
    process.stdout.write(text);
    if (eventsStream) eventsStream.write(text);
  });

  child.stderr.on("data", (data) => {
    const text = data.toString();
    stderr += text;
    process.stderr.write(text);
  });

  let spawnError = null;
  const exitCode = await new Promise((resolve) => {
    child.on("error", (err) => {
      spawnError = err;
      resolve(null);
    });
    child.on("close", resolve);
  });

  if (eventsStream) {
    eventsStream.close();
  }

  currentChild = null;

  if (spawnError) {
    throw spawnError;
  }

  const sessionIdFromJson = parseSessionIdFromJsonLines(`${stdout}\n${stderr}`);
  const sessionIdFromText = parseSessionIdFromText(stdout) || parseSessionIdFromText(stderr);
  const sessionId = sessionIdFromJson || sessionIdFromText || resumeSessionId || null;

  return {
    exitCode,
    sessionId,
    stdout,
    stderr,
  };
}

function createInitialState({
  loopId,
  workspaceRoot,
  prompt,
  completionPromise,
  promiseMode,
  maxIterations,
  statePath,
  artifactsDir,
  summaryJson,
  jsonlEventsBase,
  todoFile,
  hardStopToken,
  hardStopMode,
  samePromptEachIteration,
  codexOptions,
}) {
  return {
    loop_id: loopId,
    created_at: nowIso(),
    updated_at: nowIso(),
    workspace_root: workspaceRoot,
    prompt,
    completion_promise: completionPromise,
    promise_mode: promiseMode,
    max_iterations: maxIterations,
    same_prompt_each_iteration: samePromptEachIteration,
    iteration: 0,
    status: "running",
    codex: {
      session_id: null,
      model: codexOptions.model || null,
      sandbox: codexOptions.sandbox || null,
      approval: codexOptions.askForApproval || null,
      profile: codexOptions.profile || null,
    },
    todo: todoFile
      ? {
          path: relToWorkspace(todoFile, workspaceRoot),
          hard_stop_token: hardStopToken,
          hard_stop_mode: hardStopMode,
          paused_for_hard_stop: false,
        }
      : null,
    artifacts: {
      dir: relToWorkspace(artifactsDir, workspaceRoot),
      last_message_path: null,
      jsonl_path: null,
      jsonl_events_base: jsonlEventsBase
        ? relToWorkspace(jsonlEventsBase, workspaceRoot)
        : null,
      summary_json_path: summaryJson ? relToWorkspace(summaryJson, workspaceRoot) : null,
    },
    history: [],
    last_result: null,
    state_path: relToWorkspace(statePath, workspaceRoot),
  };
}

function buildCodexOptions(options, workspaceRoot, fallback = {}) {
  const sandboxFromOptions =
    options.sandbox || (options.fullAuto ? "workspace-write" : null);
  const approvalFromOptions = options.askForApproval || (options.fullAuto ? "on-request" : null);

  return {
    model: options.model || fallback.model || null,
    profile: options.profile || fallback.profile || null,
    sandbox: sandboxFromOptions || fallback.sandbox || DEFAULT_SANDBOX,
    askForApproval: approvalFromOptions || fallback.approval || DEFAULT_APPROVAL,
    fullAuto: options.fullAuto || false,
    skipGitRepoCheck: options.skipGitRepoCheck || false,
    cd: workspaceRoot,
  };
}

function updateSummary(summaryPath, state) {
  if (!summaryPath) return;
  const summary = {
    loop_id: state.loop_id,
    status: state.status,
    iteration: state.iteration,
    max_iterations: state.max_iterations,
    completion_promise: state.completion_promise,
    promise_mode: state.promise_mode,
    history: state.history,
    workspace_root: state.workspace_root,
    artifacts: state.artifacts,
    last_result: state.last_result,
    updated_at: state.updated_at,
  };
  writeJson(summaryPath, summary);
}

function resolveStatePath(loopId, stateFile, workspaceRoot) {
  if (stateFile) return path.resolve(stateFile);
  if (!loopId) {
    throw new Error("A loop id is required when no state file is provided.");
  }
  return path.resolve(workspaceRoot, ".codex/waylon-smithers/loops", `${loopId}.json`);
}

function resolveArtifactsDir(loopId, workspaceRoot) {
  return path.resolve(workspaceRoot, ".codex/waylon-smithers/loops", loopId);
}

function deleteArtifacts(artifactsDir, statePath) {
  if (fs.existsSync(artifactsDir)) {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (fs.existsSync(statePath)) {
    fs.rmSync(statePath, { force: true });
  }
}

function renderPromptHelper(loopId, completionPromise) {
  return [
    `Waylon-Smithers loop preset`,
    `Loop ID placeholder: ${loopId}`,
    "",
    "Add this to a Codex custom prompt to quickly scaffold Smithers loops.",
    "",
    "Instructions:",
    "- Keep iterating until the completion promise is valid.",
    "- Prefer deterministic verification (tests, linters).",
    `- Output the promise token only when done: <promise>${completionPromise}</promise>`,
  ].join("\n");
}

function renderSkillHelper(completionPromise) {
  return [
    "# Waylon Smithers loop skill",
    "",
    "## When to use",
    "- Long-running tasks that need many iterations",
    "- Test/lint fixation loops",
    "- Greenfield projects where you can walk away",
    "- Tasks requiring iteration and refinement (e.g., getting tests to pass)",
    "",
    "## Philosophy (Ralph Wiggum pattern)",
    "- Iteration > perfection: don't aim for perfect on first try; let the loop refine your work.",
    "- Failures are data: use test/lint failures to inform the next iteration.",
    "- You have access to your own previous work in files and git history.",
    "- Read your previous output and commit history to understand what's been done.",
    "- Persistence wins: keep trying until success.",
    "",
    "## Rules",
    `- Output <promise>${completionPromise}</promise> only when the task is fully complete and validated.`,
    "- If blocked, write a short BLOCKED section with what is needed.",
    "- Prefer deterministic checks (tests, linters, typechecks) before claiming completion.",
    "- After verifying, if any check fails, fix the issue and verify again.",
    "- Stop at HARD STOP markers in TODO files and ask for review.",
    "",
    "## Best practices for prompts",
    "- Set clear completion criteria with specific verification steps.",
    "- Break complex tasks into incremental goals.",
    "- Include self-correction: write tests, run them, fix failures, repeat.",
    "- Always set a reasonable --max-iterations as a safety net.",
  ].join("\n");
}

function parseInteger(value) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error("Value must be a positive integer.");
  }
  return parsed;
}

module.exports = {
  // Constants
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_COMPLETION_PROMISE,
  DEFAULT_PROMISE_MODE,
  DEFAULT_SANDBOX,
  DEFAULT_APPROVAL,
  DEFAULT_HARD_STOP_TOKEN,
  DEFAULT_HARD_STOP_MODE,
  DEFAULT_SAME_PROMPT_EACH_ITERATION,

  // Internal state management (for testing)
  _setCurrentChild,
  _setSigintReceived,
  _getSigintReceived,

  // Utility functions
  nowIso,
  defaultLoopId,
  ensureDirFor,
  relToWorkspace,
  writeJson,
  readJson,
  loadState,
  saveState,
  warnDangerous,

  // Prompt building
  buildPromptTemplate,
  buildContinuePrompt,

  // Completion detection
  detectCompletion,
  checkHardStop,
  readFileSafe,

  // Session ID parsing
  parseSessionIdFromText,
  parseSessionIdFromJsonLines,

  // Path computation
  computeJsonlPath,
  resolveStatePath,
  resolveArtifactsDir,

  // User interaction
  promptYesNo,
  registerSigintHandler,

  // Codex execution
  runCodexIteration,

  // State management
  createInitialState,
  buildCodexOptions,
  updateSummary,
  deleteArtifacts,

  // Helpers rendering
  renderPromptHelper,
  renderSkillHelper,

  // Parsing
  parseInteger,
};
