const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

// Only the external `codex` CLI (a third-party LLM agent) is mocked. State files,
// artifacts, TODO files and the interactive prompt all run for real.
jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

const { spawn } = require("child_process");

// Increase max listeners to avoid warnings
process.setMaxListeners(100);

// Import after mocking
const cli = require("../src/cli");
const lib = require("../src/lib");

// Simulates the codex CLI contract: for each spawn, write the scripted final
// message to the --output-last-message path, print a session event, and exit.
function fakeCodex(lastMessages, sessionId = "fake-session") {
  const queue = [...lastMessages];
  spawn.mockImplementation((cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn();
    const outPath = args[args.indexOf("--output-last-message") + 1];
    const message = queue.length ? queue.shift() : "still working";
    setImmediate(() => {
      fs.writeFileSync(outPath, message);
      child.stdout.emit("data", Buffer.from(`{"session_id": "${sessionId}"}\n`));
      child.emit("close", 0);
    });
    return child;
  });
}

function promptArg(args) {
  // args: ["exec", <prompt>, ...] or ["exec", "resume", <id>, <prompt>, ...]
  return args[1] === "resume" ? args[3] : args[1];
}

describe("integration tests", () => {
  let tmpDir;
  let mockChild;
  let originalStdout;
  let originalStderr;
  let originalLog;
  let originalError;
  let originalWarn;
  let logs;
  let errors;
  let warns;
  let sigintListenersBefore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "waylon-int-test-"));

    mockChild = new EventEmitter();
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.kill = jest.fn();
    spawn.mockReturnValue(mockChild);

    originalStdout = process.stdout.write;
    originalStderr = process.stderr.write;
    originalLog = console.log;
    originalError = console.error;
    originalWarn = console.warn;

    logs = [];
    errors = [];
    warns = [];

    process.stdout.write = jest.fn();
    process.stderr.write = jest.fn();
    console.log = jest.fn((...args) => logs.push(args.join(" ")));
    console.error = jest.fn((...args) => errors.push(args.join(" ")));
    console.warn = jest.fn((...args) => warns.push(args.join(" ")));

    // Reset lib state
    lib._setSigintReceived(false);
    sigintListenersBefore = process.listeners("SIGINT");
  });

  afterEach(() => {
    // Restore spied getters (process.stdin/stdout) before touching stdout.write
    jest.restoreAllMocks();
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // runLoop registers a process-wide SIGINT handler each time; drop ours.
    for (const l of process.listeners("SIGINT")) {
      if (!sigintListenersBefore.includes(l)) process.removeListener("SIGINT", l);
    }
    spawn.mockReset();
  });

  describe("runLoop", () => {
    test("completes when promise detected in first iteration", async () => {
      const loopId = "complete-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      const statePath = path.join(loopsDir, `${loopId}.json`);

      fs.mkdirSync(artifactsDir, { recursive: true });

      const state = {
        loop_id: loopId,
        prompt: "Do task",
        completion_promise: "DONE",
        promise_mode: "tag",
        max_iterations: 5,
        same_prompt_each_iteration: false,
        iteration: 0,
        status: "running",
        codex: { session_id: null, model: null, sandbox: null, approval: null, profile: null },
        todo: null,
        artifacts: { dir: artifactsDir, last_message_path: null, jsonl_path: null },
        history: [],
        last_result: null,
      };

      const runLoopPromise = cli.runLoop({
        statePath,
        state,
        workspaceRoot: tmpDir,
        completionPromise: "DONE",
        promiseMode: "tag",
        maxIterations: 5,
        samePromptEachIteration: false,
        artifactsDir,
        summaryJson: path.join(artifactsDir, "summary.json"),
        jsonlEventsBase: null,
        todoFile: null,
        hardStopToken: "HARD STOP",
        hardStopMode: "pause",
        codexOptions: { cd: tmpDir, sandbox: "read-only" },
      });

      // Simulate codex returning completion promise
      mockChild.stdout.emit("data", Buffer.from('{"session_id": "session-1"}\n'));
      mockChild.emit("close", 0);

      // Write the last message file with completion promise
      const lastMessagePath = path.join(artifactsDir, "last_message_iter_1.txt");
      fs.mkdirSync(path.dirname(lastMessagePath), { recursive: true });
      fs.writeFileSync(lastMessagePath, "Task done! <promise>DONE</promise>");

      await runLoopPromise;

      expect(state.status).toBe("completed");
      expect(state.iteration).toBe(1);
      expect(state.codex.session_id).toBe("session-1");
      expect(state.history).toHaveLength(1);
      expect(state.history[0]).toMatchObject({ iteration: 1, exit_code: 0, detected_promise: true });
      expect(logs.some(l => l.includes("Completion promise detected"))).toBe(true);

      // First iteration of a new loop sends the full task prompt, not a resume
      const args = spawn.mock.calls[0][1];
      expect(args[1]).not.toBe("resume");
      expect(promptArg(args)).toContain("Task:\nDo task");
      expect(promptArg(args)).toContain("<promise>DONE</promise>");

      // State and summary were persisted to disk
      expect(lib.readJson(statePath).status).toBe("completed");
      const summary = lib.readJson(path.join(artifactsDir, "summary.json"));
      expect(summary.status).toBe("completed");
      expect(summary.iteration).toBe(1);
    });

    test("handles spawn error", async () => {
      const loopId = "error-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      const statePath = path.join(loopsDir, `${loopId}.json`);

      fs.mkdirSync(artifactsDir, { recursive: true });

      const state = {
        loop_id: loopId,
        prompt: "Do task",
        completion_promise: "DONE",
        promise_mode: "tag",
        max_iterations: 5,
        same_prompt_each_iteration: false,
        iteration: 0,
        status: "running",
        codex: { session_id: null, model: null, sandbox: null, approval: null, profile: null },
        todo: null,
        artifacts: { dir: artifactsDir, last_message_path: null, jsonl_path: null },
        history: [],
        last_result: null,
      };

      const runLoopPromise = cli.runLoop({
        statePath,
        state,
        workspaceRoot: tmpDir,
        completionPromise: "DONE",
        promiseMode: "tag",
        maxIterations: 5,
        samePromptEachIteration: false,
        artifactsDir,
        summaryJson: null,
        jsonlEventsBase: null,
        todoFile: null,
        hardStopToken: "HARD STOP",
        hardStopMode: "pause",
        codexOptions: { cd: tmpDir, sandbox: "read-only" },
      });

      mockChild.emit("error", new Error("codex not found"));

      await runLoopPromise;

      expect(state.status).toBe("error_spawn");
      expect(state.last_result).toEqual({ exit_code: null, detected_promise: false });
      expect(lib.readJson(statePath).status).toBe("error_spawn");
      expect(errors.some(e => e.includes("codex exec failed"))).toBe(true);
    });

    test("handles no session id", async () => {
      const loopId = "no-session-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      const statePath = path.join(loopsDir, `${loopId}.json`);

      fs.mkdirSync(artifactsDir, { recursive: true });

      const state = {
        loop_id: loopId,
        prompt: "Do task",
        completion_promise: "DONE",
        promise_mode: "tag",
        max_iterations: 5,
        same_prompt_each_iteration: false,
        iteration: 0,
        status: "running",
        codex: { session_id: null, model: null, sandbox: null, approval: null, profile: null },
        todo: null,
        artifacts: { dir: artifactsDir, last_message_path: null, jsonl_path: null },
        history: [],
        last_result: null,
      };

      const runLoopPromise = cli.runLoop({
        statePath,
        state,
        workspaceRoot: tmpDir,
        completionPromise: "DONE",
        promiseMode: "tag",
        maxIterations: 5,
        samePromptEachIteration: false,
        artifactsDir,
        summaryJson: null,
        jsonlEventsBase: null,
        todoFile: null,
        hardStopToken: "HARD STOP",
        hardStopMode: "pause",
        codexOptions: { cd: tmpDir, sandbox: "read-only" },
      });

      // No session id in output
      mockChild.stdout.emit("data", Buffer.from("no session here\n"));
      mockChild.emit("close", 0);

      await runLoopPromise;

      expect(state.status).toBe("error_no_session");
      expect(state.iteration).toBe(0);
      expect(lib.readJson(statePath).status).toBe("error_no_session");
      expect(errors.some(e => e.includes("Unable to detect Codex session id"))).toBe(true);
    });

    test("uses full prompt when samePromptEachIteration is true", async () => {
      const loopId = "ralph-mode-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      const statePath = path.join(loopsDir, `${loopId}.json`);

      fs.mkdirSync(artifactsDir, { recursive: true });

      const state = {
        loop_id: loopId,
        prompt: "Do task",
        completion_promise: "DONE",
        promise_mode: "tag",
        max_iterations: 2,
        same_prompt_each_iteration: true,
        iteration: 0,
        status: "running",
        codex: { session_id: "existing-session", model: null, sandbox: null, approval: null, profile: null },
        todo: null,
        artifacts: { dir: artifactsDir, last_message_path: null, jsonl_path: null },
        history: [],
        last_result: null,
      };

      const runLoopPromise = cli.runLoop({
        statePath,
        state,
        workspaceRoot: tmpDir,
        completionPromise: "DONE",
        promiseMode: "tag",
        maxIterations: 2,
        samePromptEachIteration: true,
        artifactsDir,
        summaryJson: null,
        jsonlEventsBase: null,
        todoFile: null,
        hardStopToken: "HARD STOP",
        hardStopMode: "pause",
        codexOptions: { cd: tmpDir, sandbox: "read-only" },
      });

      mockChild.stdout.emit("data", Buffer.from('{"session_id": "session-1"}\n'));
      mockChild.emit("close", 0);

      const lastMessagePath = path.join(artifactsDir, "last_message_iter_1.txt");
      fs.writeFileSync(lastMessagePath, "<promise>DONE</promise>");

      await runLoopPromise;

      // In Ralph mode the full task prompt is sent even when resuming a session
      const args = spawn.mock.calls[0][1];
      expect(args.slice(0, 3)).toEqual(["exec", "resume", "existing-session"]);
      expect(promptArg(args)).toContain("Waylon-Smithers loop\nLoop ID: ralph-mode-loop");
      expect(promptArg(args)).toContain("Task:\nDo task");
      expect(promptArg(args)).not.toContain("Continue the Waylon-Smithers loop");
      expect(state.status).toBe("completed");
    });

    test("handles HARD STOP with exit mode", async () => {
      const loopId = "hard-stop-exit-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      const statePath = path.join(loopsDir, `${loopId}.json`);
      const todoPath = path.join(tmpDir, "TODO.md");

      fs.mkdirSync(artifactsDir, { recursive: true });
      fs.writeFileSync(todoPath, "# Tasks\n- HARD STOP here");

      const state = {
        loop_id: loopId,
        prompt: "Do task",
        completion_promise: "DONE",
        promise_mode: "tag",
        max_iterations: 5,
        same_prompt_each_iteration: false,
        iteration: 0,
        status: "running",
        codex: { session_id: null, model: null, sandbox: null, approval: null, profile: null },
        todo: { path: "TODO.md", hard_stop_token: "HARD STOP", hard_stop_mode: "exit", paused_for_hard_stop: false },
        artifacts: { dir: artifactsDir, last_message_path: null, jsonl_path: null },
        history: [],
        last_result: null,
      };

      const runLoopPromise = cli.runLoop({
        statePath,
        state,
        workspaceRoot: tmpDir,
        completionPromise: "DONE",
        promiseMode: "tag",
        maxIterations: 5,
        samePromptEachIteration: false,
        artifactsDir,
        summaryJson: null,
        jsonlEventsBase: null,
        todoFile: todoPath,
        hardStopToken: "HARD STOP",
        hardStopMode: "exit",
        codexOptions: { cd: tmpDir, sandbox: "read-only" },
      });

      mockChild.stdout.emit("data", Buffer.from('{"session_id": "session-1"}\n'));
      mockChild.emit("close", 0);

      const lastMessagePath = path.join(artifactsDir, "last_message_iter_1.txt");
      fs.writeFileSync(lastMessagePath, "Working...");

      await runLoopPromise;

      expect(state.status).toBe("paused_hard_stop");
      expect(state.todo.paused_for_hard_stop).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(logs.some(l => l.includes("HARD STOP token found"))).toBe(true);
      expect(logs.some(l => l.includes("Exiting loop"))).toBe(true);
    });

    test("handles HARD STOP with pause mode - user declines", async () => {
      const loopId = "hard-stop-pause-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      const statePath = path.join(loopsDir, `${loopId}.json`);
      const todoPath = path.join(tmpDir, "TODO.md");

      fs.mkdirSync(artifactsDir, { recursive: true });
      fs.writeFileSync(todoPath, "# Tasks\n- HARD STOP here");

      // The user answers "n" at the real readline prompt
      const stdin = new PassThrough();
      jest.spyOn(process, "stdin", "get").mockReturnValue(stdin);
      jest.spyOn(process, "stdout", "get").mockReturnValue(new PassThrough());
      fakeCodex(["Working..."], "session-1");

      const state = {
        loop_id: loopId,
        prompt: "Do task",
        completion_promise: "DONE",
        promise_mode: "tag",
        max_iterations: 5,
        same_prompt_each_iteration: false,
        iteration: 0,
        status: "running",
        codex: { session_id: null, model: null, sandbox: null, approval: null, profile: null },
        todo: { path: "TODO.md", hard_stop_token: "HARD STOP", hard_stop_mode: "pause", paused_for_hard_stop: false },
        artifacts: { dir: artifactsDir, last_message_path: null, jsonl_path: null },
        history: [],
        last_result: null,
      };

      const runLoopPromise = cli.runLoop({
        statePath,
        state,
        workspaceRoot: tmpDir,
        completionPromise: "DONE",
        promiseMode: "tag",
        maxIterations: 5,
        samePromptEachIteration: false,
        artifactsDir,
        summaryJson: null,
        jsonlEventsBase: null,
        todoFile: todoPath,
        hardStopToken: "HARD STOP",
        hardStopMode: "pause",
        codexOptions: { cd: tmpDir, sandbox: "read-only" },
      });

      // Answer once the prompt is actually waiting for input
      const answered = new Promise((resolve) => {
        const timer = setInterval(() => {
          if (process.stdin.listenerCount("data") > 0 || process.stdin.listenerCount("readable") > 0) {
            clearInterval(timer);
            process.stdin.write("n\n");
            resolve();
          }
        }, 1);
      });

      await runLoopPromise;
      await answered;

      expect(state.status).toBe("paused_hard_stop");
      expect(state.todo.paused_for_hard_stop).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(logs.some(l => l.includes("Pausing loop"))).toBe(true);
    });

    test("uses continue prompt when session exists and not ralph mode", async () => {
      const loopId = "continue-prompt-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      const statePath = path.join(loopsDir, `${loopId}.json`);

      fs.mkdirSync(artifactsDir, { recursive: true });

      const state = {
        loop_id: loopId,
        prompt: "Do task",
        completion_promise: "DONE",
        promise_mode: "tag",
        max_iterations: 1,
        same_prompt_each_iteration: false,
        iteration: 0,
        status: "running",
        codex: { session_id: "existing-session-id", model: null, sandbox: null, approval: null, profile: null },
        todo: null,
        artifacts: { dir: artifactsDir, last_message_path: null, jsonl_path: null },
        history: [],
        last_result: null,
      };

      const runLoopPromise = cli.runLoop({
        statePath,
        state,
        workspaceRoot: tmpDir,
        completionPromise: "DONE",
        promiseMode: "tag",
        maxIterations: 1,
        samePromptEachIteration: false,
        artifactsDir,
        summaryJson: null,
        jsonlEventsBase: null,
        todoFile: null,
        hardStopToken: "HARD STOP",
        hardStopMode: "pause",
        codexOptions: { cd: tmpDir, sandbox: "read-only" },
      });

      mockChild.stdout.emit("data", Buffer.from('{"session_id": "session-1"}\n'));
      mockChild.emit("close", 0);

      const lastMessagePath = path.join(artifactsDir, "last_message_iter_1.txt");
      fs.writeFileSync(lastMessagePath, "<promise>DONE</promise>");

      await runLoopPromise;

      // Verify it resumed the session with the short continue prompt
      const args = spawn.mock.calls[0][1];
      expect(args.slice(0, 3)).toEqual(["exec", "resume", "existing-session-id"]);
      expect(promptArg(args)).toBe(
        lib.buildContinuePrompt({
          loopId,
          iteration: 1,
          maxIterations: 1,
          promiseMode: "tag",
          completionPromise: "DONE",
        })
      );
    });

    test("warns on dangerous settings", async () => {
      const loopId = "danger-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      const statePath = path.join(loopsDir, `${loopId}.json`);

      fs.mkdirSync(artifactsDir, { recursive: true });

      const state = {
        loop_id: loopId,
        prompt: "Do task",
        completion_promise: "DONE",
        promise_mode: "tag",
        max_iterations: 1,
        same_prompt_each_iteration: false,
        iteration: 0,
        status: "running",
        codex: { session_id: null, model: null, sandbox: null, approval: null, profile: null },
        todo: null,
        artifacts: { dir: artifactsDir, last_message_path: null, jsonl_path: null },
        history: [],
        last_result: null,
      };

      const runLoopPromise = cli.runLoop({
        statePath,
        state,
        workspaceRoot: tmpDir,
        completionPromise: "DONE",
        promiseMode: "tag",
        maxIterations: 1,
        samePromptEachIteration: false,
        artifactsDir,
        summaryJson: null,
        jsonlEventsBase: null,
        todoFile: null,
        hardStopToken: "HARD STOP",
        hardStopMode: "pause",
        codexOptions: { cd: tmpDir, sandbox: "danger-full-access" },
      });

      mockChild.stdout.emit("data", Buffer.from('{"session_id": "session-1"}\n'));
      mockChild.emit("close", 0);

      const lastMessagePath = path.join(artifactsDir, "last_message_iter_1.txt");
      fs.writeFileSync(lastMessagePath, "<promise>DONE</promise>");

      await runLoopPromise;

      expect(warns.some(w => w.includes("dangerous settings"))).toBe(true);
    });
  });

  describe("handleStart", () => {
    test("throws when state file already exists", async () => {
      const loopId = "existing-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      fs.mkdirSync(loopsDir, { recursive: true });
      fs.writeFileSync(path.join(loopsDir, `${loopId}.json`), "{}");

      await expect(
        cli.handleStart("Do task", { cd: tmpDir, loopId })
      ).rejects.toThrow("State file already exists");
    });
  });

  describe("handleResume", () => {
    test("resumes loop with overrides", async () => {
      const loopId = "resume-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      fs.mkdirSync(artifactsDir, { recursive: true });

      const state = {
        loop_id: loopId,
        workspace_root: tmpDir,
        prompt: "Do task",
        completion_promise: "DONE",
        promise_mode: "tag",
        max_iterations: 10,
        same_prompt_each_iteration: false,
        iteration: 2,
        status: "paused_user_interrupt",
        codex: { session_id: "old-session", model: null, sandbox: null, approval: null, profile: null },
        todo: null,
        artifacts: { dir: `.codex/waylon-smithers/loops/${loopId}`, summary_json_path: null, jsonl_events_base: null },
        history: [],
        last_result: null,
      };

      const statePath = path.join(loopsDir, `${loopId}.json`);
      fs.writeFileSync(statePath, JSON.stringify(state));

      const resumePromise = cli.handleResume({
        loopId,
        cd: tmpDir,
        maxIterations: 15,
        completionPromise: "FINISHED",
        promiseMode: "plain",
        samePromptEachIteration: true,
      });

      // Complete immediately
      mockChild.stdout.emit("data", Buffer.from('{"session_id": "new-session"}\n'));
      mockChild.emit("close", 0);

      const lastMessagePath = path.join(artifactsDir, "last_message_iter_3.txt");
      fs.writeFileSync(lastMessagePath, "FINISHED");

      await resumePromise;

      const updatedState = lib.readJson(statePath);
      expect(updatedState.max_iterations).toBe(15);
      expect(updatedState.completion_promise).toBe("FINISHED");
      expect(updatedState.promise_mode).toBe("plain");
      expect(updatedState.same_prompt_each_iteration).toBe(true);
      // The overridden plain-mode promise is what detected completion
      expect(updatedState.status).toBe("completed");
      expect(updatedState.iteration).toBe(3);
      expect(updatedState.codex.session_id).toBe("new-session");

      const args = spawn.mock.calls[0][1];
      expect(args.slice(0, 3)).toEqual(["exec", "resume", "old-session"]);
      expect(promptArg(args)).toContain("Iteration: 3 of 15");
      expect(promptArg(args)).toContain("Completion promise (plain mode): FINISHED");
    });

    test("handles resume with todo file", async () => {
      const loopId = "resume-todo-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      fs.mkdirSync(artifactsDir, { recursive: true });

      const state = {
        loop_id: loopId,
        workspace_root: tmpDir,
        prompt: "Do task",
        completion_promise: "DONE",
        promise_mode: "tag",
        max_iterations: 10,
        same_prompt_each_iteration: false,
        iteration: 0,
        status: "paused_hard_stop",
        codex: { session_id: "session-1", model: null, sandbox: null, approval: null, profile: null },
        todo: { path: "TODO.md", hard_stop_token: "STOP", hard_stop_mode: "exit" },
        artifacts: { dir: `.codex/waylon-smithers/loops/${loopId}`, summary_json_path: "summary.json", jsonl_events_base: null },
        history: [],
        last_result: null,
      };

      const statePath = path.join(loopsDir, `${loopId}.json`);
      fs.writeFileSync(statePath, JSON.stringify(state));

      // Create TODO without HARD STOP
      fs.writeFileSync(path.join(tmpDir, "TODO.md"), "# Tasks");

      const resumePromise = cli.handleResume({
        loopId,
        cd: tmpDir,
      });

      mockChild.stdout.emit("data", Buffer.from('{"session_id": "session-2"}\n'));
      mockChild.emit("close", 0);

      const lastMessagePath = path.join(artifactsDir, "last_message_iter_1.txt");
      fs.writeFileSync(lastMessagePath, "<promise>DONE</promise>");

      await resumePromise;

      const updatedState = lib.readJson(statePath);
      expect(updatedState.status).toBe("completed");
    });
  });

  describe("multi-iteration loops", () => {
    function baseState(loopId, artifactsDir, overrides = {}) {
      return {
        loop_id: loopId,
        prompt: "Do task",
        completion_promise: "DONE",
        promise_mode: "tag",
        max_iterations: 3,
        same_prompt_each_iteration: false,
        iteration: 0,
        status: "running",
        codex: { session_id: null, model: null, sandbox: null, approval: null, profile: null },
        todo: null,
        artifacts: { dir: artifactsDir, last_message_path: null, jsonl_path: null },
        history: [],
        last_result: null,
        ...overrides,
      };
    }

    test("stops at max iterations when the promise never appears", async () => {
      const loopId = "max-iter-loop";
      const artifactsDir = path.join(tmpDir, ".codex/waylon-smithers/loops", loopId);
      const statePath = `${artifactsDir}.json`;
      const state = baseState(loopId, artifactsDir);
      fakeCodex(["working 1", "working 2", "working 3"], "sess-max");

      await cli.runLoop({
        statePath,
        state,
        workspaceRoot: tmpDir,
        completionPromise: "DONE",
        promiseMode: "tag",
        maxIterations: 3,
        samePromptEachIteration: false,
        artifactsDir,
        summaryJson: null,
        jsonlEventsBase: "events",
        todoFile: null,
        hardStopToken: "HARD STOP",
        hardStopMode: "pause",
        codexOptions: { cd: tmpDir, sandbox: "read-only" },
      });

      expect(spawn).toHaveBeenCalledTimes(3);
      expect(state.status).toBe("stopped_max_iterations");
      expect(state.iteration).toBe(3);
      expect(state.history.map((h) => h.detected_promise)).toEqual([false, false, false]);
      expect(state.history.map((h) => h.jsonl_path)).toEqual([
        path.join("events", "events_iter_1.jsonl"),
        path.join("events", "events_iter_2.jsonl"),
        path.join("events", "events_iter_3.jsonl"),
      ]);
      expect(fs.readFileSync(path.join(tmpDir, "events", "events_iter_2.jsonl"), "utf8")).toBe(
        '{"session_id": "sess-max"}\n'
      );
      expect(logs.some((l) => l.includes("Reached max iterations (3)"))).toBe(true);

      // Iteration 1 starts fresh; later iterations resume the detected session
      // with the short continue prompt.
      expect(spawn.mock.calls[0][1][1]).not.toBe("resume");
      for (const call of spawn.mock.calls.slice(1)) {
        expect(call[1].slice(0, 3)).toEqual(["exec", "resume", "sess-max"]);
        expect(promptArg(call[1])).toContain("Continue the Waylon-Smithers loop.");
      }
      expect(lib.readJson(statePath).status).toBe("stopped_max_iterations");
    });

    test("continues past a HARD STOP when the user answers yes", async () => {
      const loopId = "hard-stop-continue";
      const artifactsDir = path.join(tmpDir, ".codex/waylon-smithers/loops", loopId);
      const statePath = `${artifactsDir}.json`;
      const todoPath = path.join(tmpDir, "TODO.md");
      fs.writeFileSync(todoPath, "- HARD STOP review");

      const state = baseState(loopId, artifactsDir, {
        todo: { path: "TODO.md", hard_stop_token: "HARD STOP", hard_stop_mode: "pause", paused_for_hard_stop: false },
      });

      const stdin = new PassThrough();
      jest.spyOn(process, "stdin", "get").mockReturnValue(stdin);
      jest.spyOn(process, "stdout", "get").mockReturnValue(new PassThrough());
      fakeCodex(["first pass", "<promise>DONE</promise>"], "sess-hs");

      const runPromise = cli.runLoop({
        statePath,
        state,
        workspaceRoot: tmpDir,
        completionPromise: "DONE",
        promiseMode: "tag",
        maxIterations: 3,
        samePromptEachIteration: false,
        artifactsDir,
        summaryJson: null,
        jsonlEventsBase: null,
        todoFile: todoPath,
        hardStopToken: "HARD STOP",
        hardStopMode: "pause",
        codexOptions: { cd: tmpDir, sandbox: "read-only" },
      });

      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (stdin.listenerCount("data") > 0 || stdin.listenerCount("readable") > 0) {
            clearInterval(timer);
            stdin.write("y\n");
            resolve();
          }
        }, 1);
      });
      await runPromise;

      expect(spawn).toHaveBeenCalledTimes(2);
      expect(state.status).toBe("completed");
      expect(state.iteration).toBe(2);
      expect(state.todo.paused_for_hard_stop).toBe(false);
      // The full prompt carries the TODO rules on the first iteration
      expect(promptArg(spawn.mock.calls[0][1])).toContain(`If HARD STOP is present in ${todoPath}`);
    });
  });

  describe("handleStart end to end", () => {
    test("creates state and summary, runs codex, and completes", async () => {
      fakeCodex(["all good <promise>SHIP_IT</promise>"], "start-session");

      await cli.handleStart("Build the feature", {
        cd: tmpDir,
        loopId: "start-loop",
        completionPromise: "SHIP_IT",
        maxIterations: 4,
        model: "gpt-5",
      });

      const statePath = path.join(tmpDir, ".codex/waylon-smithers/loops/start-loop.json");
      const saved = lib.readJson(statePath);
      expect(saved).toMatchObject({
        loop_id: "start-loop",
        workspace_root: tmpDir,
        prompt: "Build the feature",
        completion_promise: "SHIP_IT",
        promise_mode: "tag",
        max_iterations: 4,
        iteration: 1,
        status: "completed",
        codex: { session_id: "start-session", model: "gpt-5", sandbox: "read-only", approval: "on-request" },
        state_path: ".codex/waylon-smithers/loops/start-loop.json",
      });
      expect(saved.artifacts.last_message_path).toBe(
        ".codex/waylon-smithers/loops/start-loop/last_message_iter_1.txt"
      );

      const summary = lib.readJson(
        path.join(tmpDir, ".codex/waylon-smithers/loops/start-loop/summary.json")
      );
      expect(summary.status).toBe("completed");

      const args = spawn.mock.calls[0][1];
      expect(args).toEqual(
        expect.arrayContaining(["--cd", tmpDir, "--model", "gpt-5", "--sandbox", "read-only"])
      );
      expect(promptArg(args)).toContain("Task:\nBuild the feature");
      expect(promptArg(args)).toContain("Iteration: 1 of 4");
    });
  });
});
