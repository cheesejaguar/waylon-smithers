const fs = require("fs");
const path = require("path");
const os = require("os");

const cli = require("../src/cli");
const lib = require("../src/lib");

describe("cli.js", () => {
  let tmpDir;
  let originalCwd;
  let originalLog;
  let originalError;
  let logs;
  let errors;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "waylon-cli-test-"));
    originalCwd = process.cwd();
    originalLog = console.log;
    originalError = console.error;
    logs = [];
    errors = [];
    console.log = jest.fn((...args) => logs.push(args.join(" ")));
    console.error = jest.fn((...args) => errors.push(args.join(" ")));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("handleStatus", () => {
    test("outputs state JSON", () => {
      const loopId = "test-status-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      fs.mkdirSync(loopsDir, { recursive: true });
      const statePath = path.join(loopsDir, `${loopId}.json`);
      const state = {
        loop_id: loopId,
        status: "running",
        iteration: 3,
        max_iterations: 10,
      };
      fs.writeFileSync(statePath, JSON.stringify(state));

      cli.handleStatus({ loopId, cd: tmpDir });

      expect(logs.length).toBe(1);
      const outputState = JSON.parse(logs[0]);
      expect(outputState.loop_id).toBe(loopId);
      expect(outputState.status).toBe("running");
    });
  });

  describe("handleList", () => {
    test("shows no loops found when directory doesn't exist", () => {
      cli.handleList({ cd: tmpDir });
      expect(logs).toContain("No loops found.");
    });

    test("shows no loops found when directory is empty", () => {
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      fs.mkdirSync(loopsDir, { recursive: true });
      cli.handleList({ cd: tmpDir });
      expect(logs).toContain("No loops found.");
    });

    test("lists loops in human-readable format", () => {
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      fs.mkdirSync(loopsDir, { recursive: true });

      const state1 = {
        loop_id: "loop-1",
        status: "completed",
        iteration: 5,
        max_iterations: 10,
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T01:00:00.000Z",
        completion_promise: "DONE",
        same_prompt_each_iteration: false,
      };
      const state2 = {
        loop_id: "loop-2",
        status: "running",
        iteration: 2,
        max_iterations: 20,
        created_at: "2024-01-02T00:00:00.000Z",
        updated_at: "2024-01-02T01:00:00.000Z",
        completion_promise: "COMPLETE",
        same_prompt_each_iteration: true,
      };

      fs.writeFileSync(path.join(loopsDir, "loop-1.json"), JSON.stringify(state1));
      fs.writeFileSync(path.join(loopsDir, "loop-2.json"), JSON.stringify(state2));

      cli.handleList({ cd: tmpDir, json: false });

      const output = logs.join("\n");
      expect(output).toContain("Loops in this workspace:");
      expect(output).toContain("loop-1");
      expect(output).toContain("loop-2 [ralph]");
      expect(output).toContain("Status: completed");
      expect(output).toContain("Status: running");
    });

    test("lists loops in JSON format", () => {
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      fs.mkdirSync(loopsDir, { recursive: true });

      const state = {
        loop_id: "json-loop",
        status: "running",
        iteration: 1,
        max_iterations: 5,
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:30:00.000Z",
        completion_promise: "DONE",
      };
      fs.writeFileSync(path.join(loopsDir, "json-loop.json"), JSON.stringify(state));

      cli.handleList({ cd: tmpDir, json: true });

      const output = JSON.parse(logs[0]);
      expect(Array.isArray(output)).toBe(true);
      expect(output[0].loop_id).toBe("json-loop");
    });

    test("skips malformed state files", () => {
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      fs.mkdirSync(loopsDir, { recursive: true });

      fs.writeFileSync(path.join(loopsDir, "bad.json"), "not valid json");
      fs.writeFileSync(path.join(loopsDir, "good.json"), JSON.stringify({
        loop_id: "good-loop",
        status: "running",
        iteration: 1,
        max_iterations: 5,
        updated_at: "2024-01-01T00:00:00.000Z",
        completion_promise: "DONE",
      }));

      cli.handleList({ cd: tmpDir, json: true });

      const output = JSON.parse(logs[0]);
      expect(output.length).toBe(1);
      expect(output[0].loop_id).toBe("good-loop");
    });

    test("shows message when all files are malformed", () => {
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      fs.mkdirSync(loopsDir, { recursive: true });
      fs.writeFileSync(path.join(loopsDir, "bad.json"), "not valid json");

      cli.handleList({ cd: tmpDir });

      expect(logs).toContain("No valid loop state files found.");
    });
  });

  describe("handleCancel", () => {
    test("cancels loop and keeps artifacts", () => {
      const loopId = "cancel-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      fs.mkdirSync(artifactsDir, { recursive: true });

      const statePath = path.join(loopsDir, `${loopId}.json`);
      const state = {
        loop_id: loopId,
        status: "running",
        artifacts: { dir: `.codex/waylon-smithers/loops/${loopId}` },
      };
      fs.writeFileSync(statePath, JSON.stringify(state));
      fs.writeFileSync(path.join(artifactsDir, "artifact.txt"), "data");

      cli.handleCancel({ loopId, cd: tmpDir, cleanupArtifacts: false });

      const updatedState = lib.readJson(statePath);
      expect(updatedState.status).toBe("canceled");
      expect(fs.existsSync(artifactsDir)).toBe(true);
      expect(logs.some(l => l.includes("Artifacts remain"))).toBe(true);
    });

    test("cancels loop and removes artifacts", () => {
      const loopId = "cancel-cleanup-loop";
      const loopsDir = path.join(tmpDir, ".codex/waylon-smithers/loops");
      const artifactsDir = path.join(loopsDir, loopId);
      fs.mkdirSync(artifactsDir, { recursive: true });

      const statePath = path.join(loopsDir, `${loopId}.json`);
      const state = {
        loop_id: loopId,
        status: "running",
        artifacts: { dir: `.codex/waylon-smithers/loops/${loopId}` },
      };
      fs.writeFileSync(statePath, JSON.stringify(state));
      fs.writeFileSync(path.join(artifactsDir, "artifact.txt"), "data");

      cli.handleCancel({ loopId, cd: tmpDir, cleanupArtifacts: true });

      expect(fs.existsSync(artifactsDir)).toBe(false);
      expect(fs.existsSync(statePath)).toBe(false);
      expect(logs.some(l => l.includes("removed artifacts"))).toBe(true);
    });
  });

  describe("installHelpers", () => {
    let originalHomedir;
    let fakeHome;

    beforeEach(() => {
      fakeHome = path.join(tmpDir, "home");
      fs.mkdirSync(fakeHome, { recursive: true });
      originalHomedir = os.homedir;
      os.homedir = () => fakeHome;
    });

    afterEach(() => {
      os.homedir = originalHomedir;
    });

    test("installs prompt and skill helpers", () => {
      cli.installHelpers({ completionPromise: "DONE", loopId: "test-loop" });

      const promptPath = path.join(fakeHome, ".codex/prompts/waylon-smithers.md");
      const skillPath = path.join(fakeHome, ".codex/skills/waylon-smithers/SKILL.md");

      expect(fs.existsSync(promptPath)).toBe(true);
      expect(fs.existsSync(skillPath)).toBe(true);

      const promptContent = fs.readFileSync(promptPath, "utf8");
      expect(promptContent).toContain("test-loop");
      expect(promptContent).toContain("DONE");

      const skillContent = fs.readFileSync(skillPath, "utf8");
      expect(skillContent).toContain("DONE");
    });

    test("uses defaults when options not provided", () => {
      cli.installHelpers({});

      const promptPath = path.join(fakeHome, ".codex/prompts/waylon-smithers.md");
      const promptContent = fs.readFileSync(promptPath, "utf8");
      expect(promptContent).toContain("<loop-id>");
      expect(promptContent).toContain("TASK_COMPLETE");
    });
  });

  describe("cliParseInteger", () => {
    test("parses valid integer", () => {
      expect(cli.cliParseInteger("10")).toBe(10);
    });

    test("throws InvalidArgumentError for invalid input", () => {
      expect(() => cli.cliParseInteger("abc")).toThrow();
    });
  });
});
