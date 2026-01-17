const { Command, InvalidArgumentError } = require("commander");
const fs = require("fs");
const path = require("path");

const lib = require("./lib");

const {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_COMPLETION_PROMISE,
  DEFAULT_PROMISE_MODE,
  DEFAULT_SANDBOX,
  DEFAULT_APPROVAL,
  DEFAULT_HARD_STOP_TOKEN,
  DEFAULT_HARD_STOP_MODE,
  DEFAULT_SAME_PROMPT_EACH_ITERATION,
  nowIso,
  defaultLoopId,
  ensureDirFor,
  relToWorkspace,
  writeJson,
  readJson,
  loadState,
  saveState,
  warnDangerous,
  buildPromptTemplate,
  buildContinuePrompt,
  detectCompletion,
  checkHardStop,
  readFileSafe,
  parseSessionIdFromText,
  parseSessionIdFromJsonLines,
  computeJsonlPath,
  resolveStatePath,
  resolveArtifactsDir,
  promptYesNo,
  registerSigintHandler,
  runCodexIteration,
  createInitialState,
  buildCodexOptions,
  updateSummary,
  deleteArtifacts,
  renderPromptHelper,
  renderSkillHelper,
  parseInteger,
  _setSigintReceived,
  _getSigintReceived,
} = lib;

async function runLoop({
  statePath,
  state,
  workspaceRoot,
  completionPromise,
  promiseMode,
  maxIterations,
  samePromptEachIteration,
  artifactsDir,
  summaryJson,
  jsonlEventsBase,
  todoFile,
  hardStopToken,
  hardStopMode,
  codexOptions,
}) {
  _setSigintReceived(false);
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
    if (_getSigintReceived()) break;

    const lastMessagePath = path.resolve(artifactsDir, `last_message_iter_${iteration}.txt`);
    const jsonlPath = computeJsonlPath(jsonlEventsBase, iteration, workspaceRoot);

    ensureDirFor(lastMessagePath);
    if (jsonlPath) ensureDirFor(jsonlPath);

    // When samePromptEachIteration is true (Ralph Wiggum mode), always use the full prompt.
    // Otherwise, use the full prompt only for the first iteration and a shorter continue prompt
    // for subsequent iterations.
    const useFullPrompt = state.codex.session_id == null || samePromptEachIteration;
    const prompt = useFullPrompt
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
  const samePromptEachIteration =
    options.samePromptEachIteration ?? DEFAULT_SAME_PROMPT_EACH_ITERATION;
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
    samePromptEachIteration,
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
    samePromptEachIteration: initialState.same_prompt_each_iteration,
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
  if (options.samePromptEachIteration !== undefined) {
    state.same_prompt_each_iteration = options.samePromptEachIteration;
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
    samePromptEachIteration: state.same_prompt_each_iteration ?? DEFAULT_SAME_PROMPT_EACH_ITERATION,
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

function handleList(options) {
  const workspaceRoot = path.resolve(options.cd || process.cwd());
  const loopsDir = path.resolve(workspaceRoot, ".codex/waylon-smithers/loops");

  if (!fs.existsSync(loopsDir)) {
    console.log("No loops found.");
    return;
  }

  const files = fs.readdirSync(loopsDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("No loops found.");
    return;
  }

  const loops = [];
  for (const file of files) {
    const filePath = path.join(loopsDir, file);
    try {
      const state = readJson(filePath);
      loops.push({
        loop_id: state.loop_id,
        status: state.status,
        iteration: state.iteration,
        max_iterations: state.max_iterations,
        created_at: state.created_at,
        updated_at: state.updated_at,
        completion_promise: state.completion_promise,
        same_prompt_each_iteration: state.same_prompt_each_iteration || false,
      });
    } catch (err) {
      // Skip malformed state files
    }
  }

  if (loops.length === 0) {
    console.log("No valid loop state files found.");
    return;
  }

  // Sort by updated_at descending (most recent first)
  loops.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));

  if (options.json) {
    console.log(JSON.stringify(loops, null, 2));
  } else {
    console.log("Loops in this workspace:\n");
    for (const loop of loops) {
      const modeLabel = loop.same_prompt_each_iteration ? " [ralph]" : "";
      console.log(`  ${loop.loop_id}${modeLabel}`);
      console.log(`    Status: ${loop.status}`);
      console.log(`    Iteration: ${loop.iteration}/${loop.max_iterations}`);
      console.log(`    Promise: ${loop.completion_promise}`);
      console.log(`    Updated: ${loop.updated_at}`);
      console.log("");
    }
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

function installHelpers(options) {
  const os = require("os");
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

function cliParseInteger(value) {
  try {
    return parseInteger(value);
  } catch (err) {
    throw new InvalidArgumentError(err.message);
  }
}

// Only run CLI if this is the main module
if (require.main === module || process.env.WAYLON_CLI_RUN === "1") {
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
    .command("list")
    .description("List all loops in the workspace")
    .option("--cd <path>", "Workspace root to scan for loops")
    .option("--json", "Output as JSON", false)
    .action((opts) => {
      try {
        handleList(opts);
      } catch (err) {
        console.error(`Failed to list loops: ${err.message}`);
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
    .option("--max-iterations <n>", "Override the stored max iterations", cliParseInteger)
    .option("--completion-promise <text>", "Override the completion promise")
    .option("--promise-mode <mode>", "Override promise detection mode (tag|plain|regex)")
    .option("--same-prompt-each-iteration", "Use full prompt every iteration (Ralph Wiggum mode)")
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
    .option("--max-iterations <n>", "Maximum iterations before stopping", cliParseInteger, DEFAULT_MAX_ITERATIONS)
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
    .option(
      "--same-prompt-each-iteration",
      "Use full prompt every iteration (Ralph Wiggum mode)",
      DEFAULT_SAME_PROMPT_EACH_ITERATION
    )
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
}

// Export for testing
module.exports = {
  runLoop,
  handleStart,
  handleResume,
  handleStatus,
  handleList,
  handleCancel,
  installHelpers,
  cliParseInteger,
};
