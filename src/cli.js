const { Command, InvalidArgumentError } = require("commander");
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

let currentChild = null;
let sigintReceived = false;

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
    "Rules:",
    promiseRule,
    "If blocked, output a short BLOCKED section with what is needed to proceed.",
    "Prefer deterministic verification steps (tests, linters, typechecks) before claiming completion.",
    ...todoRules,
    "",
    "When you are certain the task is complete, output ONLY the completion promise token on its own line.",
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

async function runLoop({
  statePath,
  state,
  workspaceRoot,
  completionPromise,
  promiseMode,
  maxIterations,
  artifactsDir,
  summaryJson,
  jsonlEventsBase,
  todoFile,
  hardStopToken,
  hardStopMode,
  codexOptions,
}) {
  sigintReceived = false;
  warnDangerous(codexOptions);
  state.artifacts.jsonl_events_base = jsonlEventsBase
    ? relToWorkspace(jsonlEventsBase, workspaceRoot)
    : null;
  registerSigintHandler(() => {
    if (state) {
      state.status = "paused_user_interrupt";
      saveState(state, statePath);
      updateSummary(summaryJson, state);
      console.error("\nPaused due to user interrupt. State saved for resume.");
    }
    process.exit(1);
  });

  const history = state.history || [];

  for (let iteration = state.iteration + 1; iteration <= maxIterations; iteration++) {
    if (sigintReceived) break;

    const lastMessagePath = path.resolve(artifactsDir, `last_message_iter_${iteration}.txt`);
    const jsonlPath = computeJsonlPath(jsonlEventsBase, iteration, workspaceRoot);

    ensureDirFor(lastMessagePath);
    if (jsonlPath) ensureDirFor(jsonlPath);

    const prompt =
      state.codex.session_id == null
        ? buildPromptTemplate({
            loopId: state.loop_id,
            iteration,
            maxIterations,
            promiseMode,
            completionPromise,
            userPrompt: state.prompt,
            todoFile,
            hardStopToken,
          })
        : buildContinuePrompt({
            loopId: state.loop_id,
            iteration,
            maxIterations,
            promiseMode,
            completionPromise,
          });

    console.log(
      `\n--- Waylon-Smithers iteration ${iteration}/${maxIterations} (loop ${state.loop_id}) ---`
    );

    let exitCode;
    let sessionId;
    try {
      const result = await runCodexIteration({
        prompt,
        resumeSessionId: state.codex.session_id,
        workspaceRoot,
        lastMessagePath,
        jsonlPath,
        codexOptions,
      });
      exitCode = result.exitCode;
      sessionId = result.sessionId;
    } catch (err) {
      console.error(`codex exec failed: ${err.message}`);
      state.status = "error_spawn";
      state.last_result = { exit_code: null, detected_promise: false };
      saveState(state, statePath);
      updateSummary(summaryJson, state);
      return;
    }

    if (!sessionId) {
      console.error("Unable to detect Codex session id. The loop cannot continue.");
      state.status = "error_no_session";
      saveState(state, statePath);
      updateSummary(summaryJson, state);
      return;
    }

    state.codex.session_id = sessionId;
    state.iteration = iteration;
    state.status = "running";
    state.last_result = {
      exit_code: exitCode,
      detected_promise: false,
    };
    state.artifacts.last_message_path = relToWorkspace(lastMessagePath, workspaceRoot);
    state.artifacts.jsonl_path = jsonlPath ? relToWorkspace(jsonlPath, workspaceRoot) : null;

    const lastMessage = readFileSafe(lastMessagePath);
    const detectedPromise = detectCompletion(lastMessage, promiseMode, completionPromise);
    state.last_result.detected_promise = detectedPromise;

    const iterationRecord = {
      iteration,
      finished_at: nowIso(),
      exit_code: exitCode,
      detected_promise: detectedPromise,
      last_message_path: state.artifacts.last_message_path,
      jsonl_path: state.artifacts.jsonl_path,
    };
    history.push(iterationRecord);
    state.history = history;

    saveState(state, statePath);
    updateSummary(summaryJson, state);

    if (detectedPromise) {
      state.status = "completed";
      saveState(state, statePath);
      updateSummary(summaryJson, state);
      console.log(
        `Completion promise detected on iteration ${iteration}. Loop ${state.loop_id} completed.`
      );
      break;
    }

    if (todoFile && checkHardStop(todoFile, hardStopToken)) {
      state.status = "paused_hard_stop";
      if (state.todo) state.todo.paused_for_hard_stop = true;
      saveState(state, statePath);
      updateSummary(summaryJson, state);

      console.log(`\nHARD STOP token found in ${todoFile}.`);
      if (hardStopMode === "exit") {
        console.log("Exiting loop. Resume later to continue.");
        break;
      }

      const shouldContinue = await promptYesNo(
        "HARD STOP reached. Continue the loop after review?"
      );
      if (!shouldContinue) {
        console.log("Pausing loop. Run `waylon-smithers resume --loop-id <id>` to continue.");
        break;
      }

      if (state.todo) state.todo.paused_for_hard_stop = false;
      state.status = "running";
      saveState(state, statePath);
      updateSummary(summaryJson, state);
    }

    if (iteration >= maxIterations) {
      state.status = "stopped_max_iterations";
      saveState(state, statePath);
      updateSummary(summaryJson, state);
      console.log(
        `Reached max iterations (${maxIterations}) without detecting completion promise.`
      );
      break;
    }
  }
}

function resolveArtifactsDir(loopId, workspaceRoot) {
  return path.resolve(workspaceRoot, ".codex/waylon-smithers/loops", loopId);
}

async function handleStart(prompt, options) {
  const workspaceRoot = path.resolve(options.cd || process.cwd());
  const loopId = options.loopId || defaultLoopId(workspaceRoot);
  const statePath = resolveStatePath(loopId, options.stateFile, workspaceRoot);
  const artifactsDir = options.lastMessageDir
    ? path.resolve(options.lastMessageDir)
    : resolveArtifactsDir(loopId, workspaceRoot);
  const summaryJson = options.summaryJson
    ? path.resolve(options.summaryJson)
    : path.join(artifactsDir, "summary.json");
  const jsonlEventsBase = options.jsonlEvents
    ? path.resolve(workspaceRoot, options.jsonlEvents)
    : null;

  if (fs.existsSync(statePath)) {
    throw new Error(`State file already exists at ${statePath}. Use --loop-id to start a new loop.`);
  }

  const codexOptions = buildCodexOptions(options, workspaceRoot);
  const todoFile = options.todoFile ? path.resolve(workspaceRoot, options.todoFile) : null;
  const initialState = createInitialState({
    loopId,
    workspaceRoot,
    prompt,
    completionPromise: options.completionPromise || DEFAULT_COMPLETION_PROMISE,
    promiseMode: options.promiseMode || DEFAULT_PROMISE_MODE,
    maxIterations: options.maxIterations || DEFAULT_MAX_ITERATIONS,
    statePath,
    artifactsDir,
    summaryJson,
    jsonlEventsBase,
    todoFile,
    hardStopToken: options.hardStopToken || DEFAULT_HARD_STOP_TOKEN,
    hardStopMode: options.hardStopMode || DEFAULT_HARD_STOP_MODE,
    codexOptions,
  });

  saveState(initialState, statePath);
  updateSummary(summaryJson, initialState);

  await runLoop({
    statePath,
    state: initialState,
    workspaceRoot,
    completionPromise: initialState.completion_promise,
    promiseMode: initialState.promise_mode,
    maxIterations: initialState.max_iterations,
    artifactsDir,
    summaryJson,
    jsonlEventsBase,
    todoFile,
    hardStopToken: options.hardStopToken || DEFAULT_HARD_STOP_TOKEN,
    hardStopMode: options.hardStopMode || DEFAULT_HARD_STOP_MODE,
    codexOptions,
  });
}

async function handleResume(options) {
  const loopId = options.loopId;
  const stateLookupRoot = path.resolve(options.cd || process.cwd());
  const statePath = resolveStatePath(loopId, options.stateFile, stateLookupRoot);
  const state = loadState(statePath);
  const workspaceRoot = state.workspace_root ? path.resolve(state.workspace_root) : stateLookupRoot;
  const artifactsDir = path.resolve(workspaceRoot, state.artifacts.dir);
  const summaryJson = state.artifacts.summary_json_path
    ? path.resolve(workspaceRoot, state.artifacts.summary_json_path)
    : path.join(artifactsDir, "summary.json");
  const jsonlEventsBase = options.jsonlEvents
    ? path.resolve(workspaceRoot, options.jsonlEvents)
    : state.artifacts.jsonl_events_base
      ? path.resolve(workspaceRoot, state.artifacts.jsonl_events_base)
      : null;

  if (options.maxIterations) {
    state.max_iterations = options.maxIterations;
  }
  if (options.completionPromise) {
    state.completion_promise = options.completionPromise;
  }
  if (options.promiseMode) {
    state.promise_mode = options.promiseMode;
  }

  const codexOptions = buildCodexOptions(options, workspaceRoot);
  state.codex.model = codexOptions.model;
  state.codex.sandbox = codexOptions.sandbox;
  state.codex.approval = codexOptions.askForApproval;
  state.codex.profile = codexOptions.profile;
  saveState(state, statePath);

  await runLoop({
    statePath,
    state,
    workspaceRoot,
    completionPromise: state.completion_promise,
    promiseMode: state.promise_mode,
    maxIterations: state.max_iterations,
    artifactsDir,
    summaryJson,
    jsonlEventsBase,
    todoFile: state.todo ? path.resolve(workspaceRoot, state.todo.path) : null,
    hardStopToken: state.todo ? state.todo.hard_stop_token : DEFAULT_HARD_STOP_TOKEN,
    hardStopMode: state.todo ? state.todo.hard_stop_mode : DEFAULT_HARD_STOP_MODE,
    codexOptions,
  });
}

function handleStatus(options) {
  const workspaceRoot = path.resolve(options.cd || process.cwd());
  const statePath = resolveStatePath(options.loopId, options.stateFile, workspaceRoot);
  const state = loadState(statePath);
  console.log(JSON.stringify(state, null, 2));
}

function deleteArtifacts(artifactsDir, statePath) {
  if (fs.existsSync(artifactsDir)) {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  }
  if (fs.existsSync(statePath)) {
    fs.rmSync(statePath, { force: true });
  }
}

function handleCancel(options) {
  const workspaceRoot = path.resolve(options.cd || process.cwd());
  const statePath = resolveStatePath(options.loopId, options.stateFile, workspaceRoot);
  const state = loadState(statePath);
  state.status = "canceled";
  saveState(state, statePath);

  if (options.cleanupArtifacts) {
    const artifactsDir = path.resolve(workspaceRoot, state.artifacts.dir);
    deleteArtifacts(artifactsDir, statePath);
    console.log(`Canceled loop ${state.loop_id} and removed artifacts.`);
    return;
  }

  console.log(`Canceled loop ${state.loop_id}. Artifacts remain at ${state.artifacts.dir}.`);
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
    "",
    "## Rules",
    `- Output <promise>${completionPromise}</promise> only when the task is fully complete and validated.`,
    "- If blocked, write a short BLOCKED section with what is needed.",
    "- Prefer deterministic checks (tests, linters, typechecks).",
    "- Stop at HARD STOP markers in TODO files and ask for review.",
  ].join("\n");
}

function installHelpers(options) {
  const promptDir = path.join(os.homedir(), ".codex/prompts");
  const skillDir = path.join(os.homedir(), ".codex/skills/waylon-smithers");
  const promptPath = path.join(promptDir, "waylon-smithers.md");
  const skillPath = path.join(skillDir, "SKILL.md");

  ensureDirFor(promptPath);
  ensureDirFor(skillPath);

  const completionPromise = options.completionPromise || DEFAULT_COMPLETION_PROMISE;
  const loopIdPlaceholder = options.loopId || "<loop-id>";

  fs.writeFileSync(promptPath, renderPromptHelper(loopIdPlaceholder, completionPromise));
  fs.writeFileSync(skillPath, renderSkillHelper(completionPromise));

  console.log(`Installed prompt helper at ${promptPath}`);
  console.log(`Installed skill helper at ${skillPath}`);
}

function parseInteger(value) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive integer.");
  }
  return parsed;
}

const program = new Command();
program
  .name("waylon-smithers")
  .description("Persistent Codex CLI iteration loop with completion promises")
  .version("0.1.0");

program
  .command("status")
  .description("Show loop status from state file")
  .requiredOption("--loop-id <id>", "Loop id to inspect")
  .option("--state-file <path>", "Path to state file (overrides loop id lookup)")
  .option("--cd <path>", "Workspace root to resolve state path")
  .action((opts) => {
    try {
      handleStatus(opts);
    } catch (err) {
      console.error(`Failed to load status: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("cancel")
  .description("Cancel a running loop and optionally remove artifacts")
  .requiredOption("--loop-id <id>", "Loop id to cancel")
  .option("--state-file <path>", "Path to state file (overrides loop id lookup)")
  .option("--cd <path>", "Workspace root to resolve state path")
  .option("--cleanup-artifacts", "Remove stored artifacts after canceling", false)
  .action((opts) => {
    try {
      handleCancel(opts);
    } catch (err) {
      console.error(`Failed to cancel loop: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("resume")
  .description("Resume a paused loop using saved state")
  .requiredOption("--loop-id <id>", "Loop id to resume")
  .option("--state-file <path>", "Path to state file (overrides loop id lookup)")
  .option("--cd <path>", "Workspace root to resolve state path")
  .option("--max-iterations <n>", "Override the stored max iterations", parseInteger)
  .option("--completion-promise <text>", "Override the completion promise")
  .option("--promise-mode <mode>", "Override promise detection mode (tag|plain|regex)")
  .option("--jsonl-events <path>", "Where to store JSONL event streams for resumed runs")
  .option("--model <model>", "Codex model override")
  .option("--profile <profile>", "Codex profile name")
  .option("--sandbox <policy>", "Sandbox policy")
  .option("--ask-for-approval <policy>", "Approval mode")
  .option("--full-auto", "Enable Codex full-auto preset", false)
  .option("--skip-git-repo-check", "Skip git repo detection for codex exec", false)
  .action(async (opts) => {
    try {
      await handleResume(opts);
    } catch (err) {
      console.error(`Failed to resume loop: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("install-helpers")
  .description("Install custom prompt and skill helper files for Smithers loops")
  .option("--completion-promise <text>", "Completion promise to include in helpers")
  .option("--loop-id <id>", "Loop id placeholder to include in helper prompt")
  .action((opts) => {
    try {
      installHelpers(opts);
    } catch (err) {
      console.error(`Failed to install helpers: ${err.message}`);
      process.exit(1);
    }
  });

program
  .argument("<prompt>", "Task prompt to run through the Smithers loop")
  .option("--max-iterations <n>", "Maximum iterations before stopping", parseInteger, DEFAULT_MAX_ITERATIONS)
  .option("--completion-promise <text>", "Completion promise token", DEFAULT_COMPLETION_PROMISE)
  .option("--promise-mode <mode>", "Promise detection mode (tag|plain|regex)", DEFAULT_PROMISE_MODE)
  .option("--loop-id <id>", "Loop identifier (defaults to <repo>-<timestamp>)")
  .option("--state-file <path>", "Path to state file")
  .option("--jsonl-events <path>", "Where to store JSONL event streams")
  .option("--last-message-dir <path>", "Directory for captured last messages")
  .option("--summary-json <path>", "Where to write summary JSON")
  .option("--todo-file <path>", "Path to TODO file for HARD STOP checkpoints")
  .option("--hard-stop-token <text>", "Token that triggers a HARD STOP", DEFAULT_HARD_STOP_TOKEN)
  .option("--hard-stop-mode <mode>", "HARD STOP behavior: pause|exit", DEFAULT_HARD_STOP_MODE)
  .option("--cd <path>", "Workspace root")
  .option("--model <model>", "Codex model")
  .option("--profile <profile>", "Codex profile")
  .option("--sandbox <policy>", "Sandbox policy (read-only|workspace-write|danger-full-access)")
  .option("--ask-for-approval <policy>", "Approval mode (untrusted|on-failure|on-request|never)")
  .option("--full-auto", "Enable Codex low-friction preset", false)
  .option("--skip-git-repo-check", "Skip git repo detection for codex exec", false)
  .action(async (prompt, opts) => {
    try {
      await handleStart(prompt, opts);
    } catch (err) {
      console.error(`Loop failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
