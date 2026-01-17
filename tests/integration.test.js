const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");

// Mock child_process
jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

// Mock readline
jest.mock("readline", () => ({
  createInterface: jest.fn(),
}));

const { spawn } = require("child_process");
const readline = require("readline");

// Increase max listeners to avoid warnings
process.setMaxListeners(100);

// Import after mocking
const cli = require("../src/cli");
const lib = require("../src/lib");

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
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
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
      expect(logs.some(l => l.includes("Completion promise detected"))).toBe(true);
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

      // In Ralph mode with existing session, it should still complete
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

      // Mock readline to return "n"
      const mockRl = {
        question: jest.fn((msg, cb) => cb("n")),
        close: jest.fn(),
      };
      readline.createInterface.mockReturnValue(mockRl);

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

      mockChild.stdout.emit("data", Buffer.from('{"session_id": "session-1"}\n'));
      mockChild.emit("close", 0);

      const lastMessagePath = path.join(artifactsDir, "last_message_iter_1.txt");
      fs.writeFileSync(lastMessagePath, "Working...");

      await runLoopPromise;

      expect(state.status).toBe("paused_hard_stop");
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

      // Verify it used the continue prompt (shorter)
      const spawnCall = spawn.mock.calls[0];
      expect(spawnCall[1]).toContain("resume");
      expect(spawnCall[1]).toContain("existing-session-id");
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
});
