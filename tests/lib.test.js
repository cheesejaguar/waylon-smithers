const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

// Only the external `codex` CLI (a third-party LLM agent) is mocked; everything
// else (filesystem, readline, prompt building, parsing) runs for real.
jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

const { spawn } = require("child_process");
const lib = require("../src/lib");

describe("lib.js", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "waylon-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("constants", () => {
    test("DEFAULT_MAX_ITERATIONS is 30", () => {
      expect(lib.DEFAULT_MAX_ITERATIONS).toBe(30);
    });

    test("DEFAULT_COMPLETION_PROMISE is TASK_COMPLETE", () => {
      expect(lib.DEFAULT_COMPLETION_PROMISE).toBe("TASK_COMPLETE");
    });

    test("DEFAULT_PROMISE_MODE is tag", () => {
      expect(lib.DEFAULT_PROMISE_MODE).toBe("tag");
    });

    test("DEFAULT_SANDBOX is read-only", () => {
      expect(lib.DEFAULT_SANDBOX).toBe("read-only");
    });

    test("DEFAULT_APPROVAL is on-request", () => {
      expect(lib.DEFAULT_APPROVAL).toBe("on-request");
    });

    test("DEFAULT_HARD_STOP_TOKEN is HARD STOP", () => {
      expect(lib.DEFAULT_HARD_STOP_TOKEN).toBe("HARD STOP");
    });

    test("DEFAULT_HARD_STOP_MODE is pause", () => {
      expect(lib.DEFAULT_HARD_STOP_MODE).toBe("pause");
    });

    test("DEFAULT_SAME_PROMPT_EACH_ITERATION is false", () => {
      expect(lib.DEFAULT_SAME_PROMPT_EACH_ITERATION).toBe(false);
    });
  });

  describe("nowIso", () => {
    test("returns ISO date string", () => {
      const result = lib.nowIso();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe("defaultLoopId", () => {
    test("generates loop id from workspace root", () => {
      const result = lib.defaultLoopId("/path/to/my-project");
      expect(result).toMatch(/^my-project-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    });

    test("uses cwd when workspaceRoot is null", () => {
      const result = lib.defaultLoopId(null);
      const cwdName = path.basename(process.cwd());
      expect(result.startsWith(`${cwdName}-`)).toBe(true);
      expect(result.slice(cwdName.length + 1)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    });
  });

  describe("ensureDirFor", () => {
    test("creates directory for file path", () => {
      const filePath = path.join(tmpDir, "nested", "dir", "file.txt");
      lib.ensureDirFor(filePath);
      expect(fs.existsSync(path.dirname(filePath))).toBe(true);
    });
  });

  describe("relToWorkspace", () => {
    test("returns relative path", () => {
      const result = lib.relToWorkspace("/workspace/src/file.js", "/workspace");
      expect(result).toBe("src/file.js");
    });

    test("returns . for same path", () => {
      const result = lib.relToWorkspace("/workspace", "/workspace");
      expect(result).toBe(".");
    });
  });

  describe("writeJson and readJson", () => {
    test("writes and reads JSON data", () => {
      const filePath = path.join(tmpDir, "data.json");
      const data = { foo: "bar", num: 42 };
      lib.writeJson(filePath, data);
      const result = lib.readJson(filePath);
      expect(result).toEqual(data);
    });
  });

  describe("loadState", () => {
    test("loads state from file", () => {
      const statePath = path.join(tmpDir, "state.json");
      const state = { loop_id: "test-loop", status: "running" };
      fs.writeFileSync(statePath, JSON.stringify(state));
      const result = lib.loadState(statePath);
      expect(result).toEqual(state);
    });

    test("throws error if file does not exist", () => {
      const statePath = path.join(tmpDir, "nonexistent.json");
      expect(() => lib.loadState(statePath)).toThrow("State file not found");
    });
  });

  describe("saveState", () => {
    test("saves state with updated_at timestamp", () => {
      const statePath = path.join(tmpDir, "state.json");
      const state = { loop_id: "test-loop", status: "running" };
      const before = Date.now();
      lib.saveState(state, statePath);
      const saved = lib.readJson(statePath);
      expect(saved.loop_id).toBe("test-loop");
      expect(saved.status).toBe("running");
      expect(saved.updated_at).toBe(state.updated_at);
      expect(Date.parse(saved.updated_at)).toBeGreaterThanOrEqual(before - 1000);
    });
  });

  describe("warnDangerous", () => {
    let originalWarn;

    beforeEach(() => {
      originalWarn = console.warn;
      console.warn = jest.fn();
    });

    afterEach(() => {
      console.warn = originalWarn;
    });

    test("warns on danger-full-access sandbox", () => {
      lib.warnDangerous({ sandbox: "danger-full-access" });
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("dangerous settings"));
    });

    test("warns on never approval", () => {
      lib.warnDangerous({ askForApproval: "never" });
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("dangerous settings"));
    });

    test("does not warn on safe settings", () => {
      lib.warnDangerous({ sandbox: "read-only", askForApproval: "on-request" });
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe("buildPromptTemplate", () => {
    test("builds tag mode template", () => {
      const result = lib.buildPromptTemplate({
        loopId: "test-loop",
        iteration: 1,
        maxIterations: 10,
        promiseMode: "tag",
        completionPromise: "DONE",
        userPrompt: "Do something",
        todoFile: null,
        hardStopToken: "HARD STOP",
      });
      expect(result).toContain("Waylon-Smithers loop");
      expect(result).toContain("Loop ID: test-loop");
      expect(result).toContain("Iteration: 1 of 10");
      expect(result).toContain("<promise>DONE</promise>");
      expect(result).toContain("Do something");
      expect(result).toContain("Ralph Wiggum pattern");
    });

    test("builds plain mode template", () => {
      const result = lib.buildPromptTemplate({
        loopId: "test-loop",
        iteration: 2,
        maxIterations: 5,
        promiseMode: "plain",
        completionPromise: "FINISHED",
        userPrompt: "Task here",
        todoFile: null,
        hardStopToken: "HARD STOP",
      });
      expect(result).toContain("Completion promise (plain mode): FINISHED");
    });

    test("builds regex mode template", () => {
      const result = lib.buildPromptTemplate({
        loopId: "test-loop",
        iteration: 1,
        maxIterations: 10,
        promiseMode: "regex",
        completionPromise: "DONE.*",
        userPrompt: "Do regex task",
        todoFile: null,
        hardStopToken: "HARD STOP",
      });
      expect(result).toContain("Regex: DONE.*");
    });

    test("includes todo rules when todoFile is provided", () => {
      const result = lib.buildPromptTemplate({
        loopId: "test-loop",
        iteration: 1,
        maxIterations: 10,
        promiseMode: "tag",
        completionPromise: "DONE",
        userPrompt: "Do task",
        todoFile: "TODO.md",
        hardStopToken: "STOP HERE",
      });
      expect(result).toContain("If STOP HERE is present in TODO.md");
      expect(result).toContain("Work through TODO items from top to bottom");
    });
  });

  describe("buildContinuePrompt", () => {
    test("builds continue prompt for tag mode", () => {
      const result = lib.buildContinuePrompt({
        loopId: "test-loop",
        iteration: 3,
        maxIterations: 10,
        promiseMode: "tag",
        completionPromise: "DONE",
      });
      expect(result).toContain("Continue the Waylon-Smithers loop");
      expect(result).toContain("Loop ID: test-loop");
      expect(result).toContain("Iteration: 3 of 10");
      expect(result).toContain("<promise>DONE</promise>");
    });

    test("builds continue prompt for plain mode", () => {
      const result = lib.buildContinuePrompt({
        loopId: "loop-2",
        iteration: 5,
        maxIterations: 20,
        promiseMode: "plain",
        completionPromise: "FINISHED",
      });
      expect(result).toContain("Remember the completion promise (plain): FINISHED");
    });
  });

  describe("detectCompletion", () => {
    test("detects tag mode completion", () => {
      expect(lib.detectCompletion("Some text <promise>DONE</promise> more text", "tag", "DONE")).toBe(true);
      expect(lib.detectCompletion("Some text without promise", "tag", "DONE")).toBe(false);
    });

    test("detects plain mode completion", () => {
      expect(lib.detectCompletion("Task is COMPLETE now", "plain", "COMPLETE")).toBe(true);
      expect(lib.detectCompletion("Task is not done", "plain", "COMPLETE")).toBe(false);
    });

    test("detects regex mode completion", () => {
      expect(lib.detectCompletion("DONE-123", "regex", "DONE-\\d+")).toBe(true);
      expect(lib.detectCompletion("DONE", "regex", "DONE-\\d+")).toBe(false);
    });

    test("returns false for invalid regex", () => {
      const originalError = console.error;
      console.error = jest.fn();
      expect(lib.detectCompletion("test", "regex", "[invalid")).toBe(false);
      expect(console.error).toHaveBeenCalled();
      console.error = originalError;
    });

    test("returns false for null/empty message", () => {
      expect(lib.detectCompletion(null, "tag", "DONE")).toBe(false);
      expect(lib.detectCompletion("", "tag", "DONE")).toBe(false);
    });
  });

  describe("checkHardStop", () => {
    test("returns true when token is in file", () => {
      const todoPath = path.join(tmpDir, "TODO.md");
      fs.writeFileSync(todoPath, "# Tasks\n- HARD STOP here\n- More tasks");
      expect(lib.checkHardStop(todoPath, "HARD STOP")).toBe(true);
    });

    test("returns false when token is not in file", () => {
      const todoPath = path.join(tmpDir, "TODO.md");
      fs.writeFileSync(todoPath, "# Tasks\n- Task 1\n- Task 2");
      expect(lib.checkHardStop(todoPath, "HARD STOP")).toBe(false);
    });

    test("returns false for null path", () => {
      expect(lib.checkHardStop(null, "HARD STOP")).toBe(false);
    });

    test("returns false for nonexistent file", () => {
      expect(lib.checkHardStop(path.join(tmpDir, "nonexistent.md"), "HARD STOP")).toBe(false);
    });
  });

  describe("readFileSafe", () => {
    test("reads existing file", () => {
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, "Hello World");
      expect(lib.readFileSafe(filePath)).toBe("Hello World");
    });

    test("returns empty string for null path", () => {
      expect(lib.readFileSafe(null)).toBe("");
    });

    test("returns empty string for nonexistent file", () => {
      expect(lib.readFileSafe(path.join(tmpDir, "nonexistent.txt"))).toBe("");
    });
  });

  describe("parseSessionIdFromText", () => {
    test("parses UUID from text", () => {
      const text = "Session: 0199a213-81c0-7800-8aa1-bbab2a035a53\nMore output";
      expect(lib.parseSessionIdFromText(text)).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");
    });

    test("returns null when no UUID found", () => {
      expect(lib.parseSessionIdFromText("No session id here")).toBeNull();
    });

    test("handles Windows line endings", () => {
      const text = "Line 1\r\nSession: 12345678-1234-1234-1234-123456789012\r\nLine 3";
      expect(lib.parseSessionIdFromText(text)).toBe("12345678-1234-1234-1234-123456789012");
    });
  });

  describe("parseSessionIdFromJsonLines", () => {
    test("parses session_id from JSON line", () => {
      const text = '{"session_id": "abc-123-def-456"}\n{"other": "data"}';
      expect(lib.parseSessionIdFromJsonLines(text)).toBe("abc-123-def-456");
    });

    test("parses session.id from JSON line", () => {
      const text = '{"session": {"id": "nested-session-id"}}\n';
      expect(lib.parseSessionIdFromJsonLines(text)).toBe("nested-session-id");
    });

    test("parses id from session type event", () => {
      const text = '{"id": "session-event-id", "type": "session"}';
      expect(lib.parseSessionIdFromJsonLines(text)).toBe("session-event-id");
    });

    test("returns null for no JSON", () => {
      expect(lib.parseSessionIdFromJsonLines("not json")).toBeNull();
    });

    test("skips malformed JSON lines", () => {
      const text = '{invalid json}\n{"session_id": "valid-id"}';
      expect(lib.parseSessionIdFromJsonLines(text)).toBe("valid-id");
    });

    test("skips lines not starting with {", () => {
      const text = 'plain text\n  spaces\n{"session_id": "found"}';
      expect(lib.parseSessionIdFromJsonLines(text)).toBe("found");
    });
  });

  describe("computeJsonlPath", () => {
    test("returns null for null base", () => {
      expect(lib.computeJsonlPath(null, 1, "/workspace")).toBeNull();
    });

    test("computes path for .jsonl file", () => {
      const result = lib.computeJsonlPath("events.jsonl", 3, "/workspace");
      expect(result).toBe(path.resolve("/workspace", "events_iter_3.jsonl"));
    });

    test("computes path for directory", () => {
      const result = lib.computeJsonlPath("logs", 5, "/workspace");
      expect(result).toBe(path.resolve("/workspace", "logs", "events_iter_5.jsonl"));
    });
  });

  describe("resolveStatePath", () => {
    test("resolves from stateFile", () => {
      const result = lib.resolveStatePath("loop-1", "/custom/state.json", "/workspace");
      expect(result).toBe(path.resolve("/custom/state.json"));
    });

    test("resolves from loopId", () => {
      const result = lib.resolveStatePath("my-loop", null, "/workspace");
      expect(result).toBe(path.resolve("/workspace", ".codex/waylon-smithers/loops", "my-loop.json"));
    });

    test("throws error when no loopId and no stateFile", () => {
      expect(() => lib.resolveStatePath(null, null, "/workspace")).toThrow("A loop id is required");
    });
  });

  describe("resolveArtifactsDir", () => {
    test("resolves artifacts directory", () => {
      const result = lib.resolveArtifactsDir("loop-123", "/workspace");
      expect(result).toBe(path.resolve("/workspace", ".codex/waylon-smithers/loops", "loop-123"));
    });
  });

  describe("deleteArtifacts", () => {
    test("deletes artifacts directory and state file", () => {
      const artifactsDir = path.join(tmpDir, "artifacts");
      const statePath = path.join(tmpDir, "state.json");
      fs.mkdirSync(artifactsDir, { recursive: true });
      fs.writeFileSync(path.join(artifactsDir, "file.txt"), "content");
      fs.writeFileSync(statePath, "{}");

      lib.deleteArtifacts(artifactsDir, statePath);

      expect(fs.existsSync(artifactsDir)).toBe(false);
      expect(fs.existsSync(statePath)).toBe(false);
    });

    test("handles nonexistent paths gracefully", () => {
      const artifactsDir = path.join(tmpDir, "nonexistent-dir");
      const statePath = path.join(tmpDir, "nonexistent.json");
      expect(() => lib.deleteArtifacts(artifactsDir, statePath)).not.toThrow();
    });
  });

  describe("createInitialState", () => {
    test("creates initial state object", () => {
      const state = lib.createInitialState({
        loopId: "test-loop",
        workspaceRoot: "/workspace",
        prompt: "Do something",
        completionPromise: "DONE",
        promiseMode: "tag",
        maxIterations: 10,
        statePath: "/workspace/.codex/waylon-smithers/loops/test-loop.json",
        artifactsDir: "/workspace/.codex/waylon-smithers/loops/test-loop",
        summaryJson: "/workspace/.codex/waylon-smithers/loops/test-loop/summary.json",
        jsonlEventsBase: null,
        todoFile: null,
        hardStopToken: "HARD STOP",
        hardStopMode: "pause",
        samePromptEachIteration: false,
        codexOptions: { model: "gpt-4", sandbox: "read-only", askForApproval: "on-request" },
      });

      expect(state.loop_id).toBe("test-loop");
      expect(state.workspace_root).toBe("/workspace");
      expect(state.prompt).toBe("Do something");
      expect(state.completion_promise).toBe("DONE");
      expect(state.promise_mode).toBe("tag");
      expect(state.max_iterations).toBe(10);
      expect(state.same_prompt_each_iteration).toBe(false);
      expect(state.iteration).toBe(0);
      expect(state.status).toBe("running");
      expect(state.codex.session_id).toBeNull();
      expect(state.codex.model).toBe("gpt-4");
      expect(state.todo).toBeNull();
      expect(state.history).toEqual([]);
    });

    test("creates state with todo file", () => {
      const state = lib.createInitialState({
        loopId: "loop-with-todo",
        workspaceRoot: "/workspace",
        prompt: "Task",
        completionPromise: "COMPLETE",
        promiseMode: "tag",
        maxIterations: 5,
        statePath: "/workspace/.codex/loops/loop.json",
        artifactsDir: "/workspace/.codex/loops/loop",
        summaryJson: null,
        jsonlEventsBase: "/workspace/events",
        todoFile: "/workspace/TODO.md",
        hardStopToken: "STOP",
        hardStopMode: "exit",
        samePromptEachIteration: true,
        codexOptions: {},
      });

      expect(state.todo).toEqual({
        path: "TODO.md",
        hard_stop_token: "STOP",
        hard_stop_mode: "exit",
        paused_for_hard_stop: false,
      });
      expect(state.same_prompt_each_iteration).toBe(true);
      expect(state.artifacts.jsonl_events_base).toBe("events");
    });
  });

  describe("buildCodexOptions", () => {
    test("builds options with defaults", () => {
      const result = lib.buildCodexOptions({}, "/workspace");
      expect(result).toEqual({
        model: null,
        profile: null,
        sandbox: "read-only",
        askForApproval: "on-request",
        fullAuto: false,
        skipGitRepoCheck: false,
        cd: "/workspace",
      });
    });

    test("builds options with overrides", () => {
      const result = lib.buildCodexOptions({
        model: "gpt-5",
        profile: "fast",
        sandbox: "workspace-write",
        askForApproval: "never",
        skipGitRepoCheck: true,
      }, "/project");

      expect(result.model).toBe("gpt-5");
      expect(result.profile).toBe("fast");
      expect(result.sandbox).toBe("workspace-write");
      expect(result.askForApproval).toBe("never");
      expect(result.skipGitRepoCheck).toBe(true);
    });

    test("handles fullAuto option", () => {
      const result = lib.buildCodexOptions({ fullAuto: true }, "/workspace");
      expect(result.sandbox).toBe("workspace-write");
      expect(result.askForApproval).toBe("on-request");
      expect(result.fullAuto).toBe(true);
    });

    test("uses fallback values", () => {
      const result = lib.buildCodexOptions({}, "/workspace", {
        model: "fallback-model",
        sandbox: "fallback-sandbox",
        approval: "fallback-approval",
      });
      expect(result.model).toBe("fallback-model");
      expect(result.sandbox).toBe("fallback-sandbox");
      expect(result.askForApproval).toBe("fallback-approval");
    });
  });

  describe("updateSummary", () => {
    test("writes summary JSON", () => {
      const summaryPath = path.join(tmpDir, "summary.json");
      const state = {
        loop_id: "test-loop",
        status: "running",
        iteration: 2,
        max_iterations: 10,
        completion_promise: "DONE",
        promise_mode: "tag",
        history: [],
        workspace_root: "/workspace",
        artifacts: {},
        last_result: null,
        updated_at: "2024-01-01T00:00:00.000Z",
      };

      lib.updateSummary(summaryPath, state);

      const saved = lib.readJson(summaryPath);
      expect(saved.loop_id).toBe("test-loop");
      expect(saved.status).toBe("running");
    });

    test("does nothing for null path", () => {
      expect(() => lib.updateSummary(null, {})).not.toThrow();
    });
  });

  describe("renderPromptHelper", () => {
    test("renders prompt helper content", () => {
      const result = lib.renderPromptHelper("my-loop", "FINISHED");
      expect(result).toContain("Waylon-Smithers loop preset");
      expect(result).toContain("Loop ID placeholder: my-loop");
      expect(result).toContain("<promise>FINISHED</promise>");
    });
  });

  describe("renderSkillHelper", () => {
    test("renders skill helper content", () => {
      const result = lib.renderSkillHelper("COMPLETE");
      expect(result).toContain("# Waylon Smithers loop skill");
      expect(result).toContain("## When to use");
      expect(result).toContain("Ralph Wiggum pattern");
      expect(result).toContain("<promise>COMPLETE</promise>");
      expect(result).toContain("## Best practices for prompts");
    });
  });

  describe("parseInteger", () => {
    test("parses valid integer", () => {
      expect(lib.parseInteger("42")).toBe(42);
      expect(lib.parseInteger("1")).toBe(1);
    });

    test("throws for non-integer", () => {
      expect(() => lib.parseInteger("abc")).toThrow("positive integer");
    });

    test("throws for zero", () => {
      expect(() => lib.parseInteger("0")).toThrow("positive integer");
    });

    test("throws for negative", () => {
      expect(() => lib.parseInteger("-5")).toThrow("positive integer");
    });
  });

  describe("internal state management", () => {
    test("_setSigintReceived and _getSigintReceived round-trip", () => {
      lib._setSigintReceived(true);
      expect(lib._getSigintReceived()).toBe(true);
      lib._setSigintReceived(false);
      expect(lib._getSigintReceived()).toBe(false);
    });
  });

  describe("registerSigintHandler", () => {
    let newListeners;

    function registerAndCapture(onInterrupt) {
      const before = process.listeners("SIGINT");
      lib.registerSigintHandler(onInterrupt);
      newListeners = process.listeners("SIGINT").filter((l) => !before.includes(l));
      expect(newListeners).toHaveLength(1);
      return newListeners[0];
    }

    afterEach(() => {
      for (const l of newListeners || []) process.removeListener("SIGINT", l);
      newListeners = [];
      lib._setCurrentChild(null);
      lib._setSigintReceived(false);
    });

    test("on SIGINT, forwards the signal to the running child and calls onInterrupt", () => {
      const child = { kill: jest.fn() };
      const onInterrupt = jest.fn();
      lib._setCurrentChild(child);
      lib._setSigintReceived(false);

      const handler = registerAndCapture(onInterrupt);
      handler();

      expect(child.kill).toHaveBeenCalledWith("SIGINT");
      expect(onInterrupt).toHaveBeenCalledTimes(1);
      expect(lib._getSigintReceived()).toBe(true);
    });

    test("on SIGINT with no child and no callback, only records the interrupt", () => {
      lib._setCurrentChild(null);
      lib._setSigintReceived(false);

      const handler = registerAndCapture(undefined);
      expect(() => handler()).not.toThrow();
      expect(lib._getSigintReceived()).toBe(true);
    });
  });

  describe("promptYesNo", () => {
    let input;
    let output;
    let written;

    beforeEach(() => {
      input = new PassThrough();
      output = new PassThrough();
      written = "";
      output.on("data", (d) => (written += d));
      jest.spyOn(process, "stdin", "get").mockReturnValue(input);
      jest.spyOn(process, "stdout", "get").mockReturnValue(output);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    async function answer(text) {
      const pending = lib.promptYesNo("Continue?");
      input.write(`${text}\n`);
      return pending;
    }

    test("asks the question with a [y/N] suffix", async () => {
      await answer("n");
      expect(written).toContain("Continue? [y/N]: ");
    });

    test("returns true for y answer", async () => {
      expect(await answer("y")).toBe(true);
    });

    test("returns true for yes answer, ignoring case and whitespace", async () => {
      expect(await answer("  YeS  ")).toBe(true);
    });

    test("returns false for n answer", async () => {
      expect(await answer("n")).toBe(false);
    });

    test("returns false for empty answer", async () => {
      expect(await answer("")).toBe(false);
    });

    test("returns false for other text", async () => {
      expect(await answer("yep")).toBe(false);
    });
  });

  describe("runCodexIteration", () => {
    let mockChild;
    let lastMessagePath;
    let stdoutWrites;
    let stderrWrites;

    beforeEach(() => {
      mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      mockChild.kill = jest.fn();
      spawn.mockReset();
      spawn.mockReturnValue(mockChild);

      lastMessagePath = path.join(tmpDir, "last.txt");
      stdoutWrites = [];
      stderrWrites = [];
      jest.spyOn(process.stdout, "write").mockImplementation((t) => stdoutWrites.push(String(t)));
      jest.spyOn(process.stderr, "write").mockImplementation((t) => stderrWrites.push(String(t)));
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test("runs codex exec with prompt and builds the full argument list", async () => {
      const resultPromise = lib.runCodexIteration({
        prompt: "Do task",
        resumeSessionId: null,
        workspaceRoot: tmpDir,
        lastMessagePath,
        jsonlPath: null,
        codexOptions: {
          cd: tmpDir,
          model: "gpt-4",
          profile: "default",
          sandbox: "read-only",
          askForApproval: "on-request",
        },
      });

      mockChild.stdout.emit("data", Buffer.from('{"session_id": "test-session-123"}\n'));
      mockChild.emit("close", 0);

      const result = await resultPromise;

      expect(spawn).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawn.mock.calls[0];
      expect(cmd).toBe("codex");
      expect(args).toEqual([
        "exec",
        "Do task",
        "--output-last-message",
        lastMessagePath,
        "--json",
        "--cd",
        tmpDir,
        "--model",
        "gpt-4",
        "--profile",
        "default",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "on-request",
      ]);
      expect(opts.cwd).toBe(tmpDir);
      expect(result).toEqual({
        exitCode: 0,
        sessionId: "test-session-123",
        stdout: '{"session_id": "test-session-123"}\n',
        stderr: "",
      });
      // Codex output is streamed through to the user's terminal
      expect(stdoutWrites.join("")).toBe('{"session_id": "test-session-123"}\n');
    });

    test("runs codex exec resume with session id and prompt", async () => {
      const resultPromise = lib.runCodexIteration({
        prompt: "Continue",
        resumeSessionId: "existing-session-456",
        workspaceRoot: tmpDir,
        lastMessagePath,
        jsonlPath: null,
        codexOptions: {},
      });

      mockChild.emit("close", 0);

      const result = await resultPromise;

      expect(spawn.mock.calls[0][1]).toEqual([
        "exec",
        "resume",
        "existing-session-456",
        "Continue",
        "--output-last-message",
        lastMessagePath,
        "--json",
      ]);
      // Falls back to the resumed session id when codex prints none
      expect(result.sessionId).toBe("existing-session-456");
    });

    test("runs codex exec resume without prompt", async () => {
      const resultPromise = lib.runCodexIteration({
        prompt: null,
        resumeSessionId: "existing-session-789",
        workspaceRoot: tmpDir,
        lastMessagePath,
        jsonlPath: null,
        codexOptions: {},
      });

      mockChild.emit("close", 0);
      await resultPromise;

      expect(spawn.mock.calls[0][1]).toEqual([
        "exec",
        "resume",
        "existing-session-789",
        "--output-last-message",
        lastMessagePath,
        "--json",
      ]);
    });

    test("writes all stdout events to the jsonl file", async () => {
      const jsonlPath = path.join(tmpDir, "events.jsonl");
      const resultPromise = lib.runCodexIteration({
        prompt: "Task",
        resumeSessionId: null,
        workspaceRoot: tmpDir,
        lastMessagePath,
        jsonlPath,
        codexOptions: {},
      });

      mockChild.stdout.emit("data", Buffer.from('{"type":"a"}\n'));
      mockChild.stdout.emit("data", Buffer.from('{"type":"b"}\n'));
      mockChild.stderr.emit("data", Buffer.from("not an event\n"));
      mockChild.emit("close", 0);

      await resultPromise;

      expect(fs.readFileSync(jsonlPath, "utf8")).toBe('{"type":"a"}\n{"type":"b"}\n');
    });

    test("captures stderr output and non-zero exit code", async () => {
      const resultPromise = lib.runCodexIteration({
        prompt: "Task",
        resumeSessionId: null,
        workspaceRoot: tmpDir,
        lastMessagePath,
        jsonlPath: null,
        codexOptions: {},
      });

      mockChild.stderr.emit("data", Buffer.from("error output"));
      mockChild.emit("close", 1);

      const result = await resultPromise;

      expect(result.stderr).toBe("error output");
      expect(result.exitCode).toBe(1);
      expect(result.sessionId).toBeNull();
      expect(stderrWrites.join("")).toBe("error output");
    });

    test("throws on spawn error", async () => {
      const resultPromise = lib.runCodexIteration({
        prompt: "Task",
        resumeSessionId: null,
        workspaceRoot: tmpDir,
        lastMessagePath,
        jsonlPath: null,
        codexOptions: {},
      });

      mockChild.emit("error", new Error("spawn failed"));

      await expect(resultPromise).rejects.toThrow("spawn failed");
    });

    test("extracts session id from text when not in JSON", async () => {
      const resultPromise = lib.runCodexIteration({
        prompt: "Task",
        resumeSessionId: null,
        workspaceRoot: tmpDir,
        lastMessagePath,
        jsonlPath: null,
        codexOptions: {},
      });

      mockChild.stdout.emit("data", Buffer.from("Session: 12345678-1234-1234-1234-123456789012\n"));
      mockChild.emit("close", 0);

      const result = await resultPromise;

      expect(result.sessionId).toBe("12345678-1234-1234-1234-123456789012");
    });

    test("extracts session id from stderr text", async () => {
      const resultPromise = lib.runCodexIteration({
        prompt: "Task",
        resumeSessionId: "old-session",
        workspaceRoot: tmpDir,
        lastMessagePath,
        jsonlPath: null,
        codexOptions: {},
      });

      mockChild.stderr.emit("data", Buffer.from("session id: 0199a213-81c0-7800-8aa1-bbab2a035a53\n"));
      mockChild.emit("close", 0);

      const result = await resultPromise;

      // A newly reported session id wins over the one being resumed
      expect(result.sessionId).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");
    });

    test("includes all codex options in args", async () => {
      const resultPromise = lib.runCodexIteration({
        prompt: "Task",
        resumeSessionId: null,
        workspaceRoot: tmpDir,
        lastMessagePath,
        jsonlPath: null,
        codexOptions: {
          cd: "/workspace",
          model: "gpt-5",
          profile: "custom",
          sandbox: "workspace-write",
          askForApproval: "never",
          fullAuto: true,
          skipGitRepoCheck: true,
        },
      });

      mockChild.emit("close", 0);
      await resultPromise;

      expect(spawn.mock.calls[0][1]).toEqual([
        "exec",
        "Task",
        "--output-last-message",
        lastMessagePath,
        "--json",
        "--cd",
        "/workspace",
        "--model",
        "gpt-5",
        "--profile",
        "custom",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "--full-auto",
        "--skip-git-repo-check",
      ]);
    });
  });
});
