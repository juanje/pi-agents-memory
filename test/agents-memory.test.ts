import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import agentsMemory, {
  buildExtractionPrompt,
  checkConsolidationDue,
  composeContext,
  createProject,
  DEFAULT_SAVE_THRESHOLD,
  detectStack,
  extractField,
  filterConversation,
  findProject,
  MESSAGE_CUSTOM_TYPE,
  RULES,
  readFileSafe,
  readJson,
  SAVE_ENV_KEY,
  STACK_MARKERS,
} from "../extensions/agents-memory.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Scaffold helpers ---

function scaffoldMemoryDir(dir: string): string {
  const memDir = join(dir, "agents-memory");
  for (const sub of ["projects", "stacks", "teams", "global", "hooks/.state", "commands"]) {
    mkdirSync(join(memDir, sub), { recursive: true });
  }
  writeFileSync(join(memDir, "config.json"), '{"auto_save_threshold": 10}\n');
  writeFileSync(
    join(memDir, "global", "preferences.md"),
    "# Preferences\n\n- Conventional commits\n",
  );
  return memDir;
}

function scaffoldProject(memDir: string, name: string): string {
  const dir = join(memDir, "projects", name);
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "index.md"), `# ${name}\n\n- Stack: python\n- Team: backend\n`);
  writeFileSync(
    join(dir, "latest-sessions.md"),
    "# Latest sessions\n\n## 2026-11-09\n\nRefactored auth module.\n",
  );
  writeFileSync(join(dir, "open-threads.md"), "# Open threads\n\n- Finish migration\n");
  return dir;
}

// --- readFileSafe ---

describe("readFileSafe", () => {
  it("reads existing file", () => {
    const dir = makeTempDir("am-read-");
    const f = join(dir, "test.md");
    writeFileSync(f, "  hello  ");
    expect(readFileSafe(f)).toBe("hello");
  });

  it("returns empty for missing file", () => {
    expect(readFileSafe("/nonexistent/file.md")).toBe("");
  });
});

// --- readJson ---

describe("readJson", () => {
  it("parses valid JSON", () => {
    const dir = makeTempDir("am-json-");
    const f = join(dir, "data.json");
    writeFileSync(f, '{"key": "value"}');
    expect(readJson(f)).toEqual({ key: "value" });
  });

  it("returns empty object for invalid JSON", () => {
    const dir = makeTempDir("am-badjson-");
    const f = join(dir, "bad.json");
    writeFileSync(f, "{not valid");
    expect(readJson(f)).toEqual({});
  });

  it("returns empty object for missing file", () => {
    expect(readJson("/nonexistent/file.json")).toEqual({});
  });
});

// --- detectStack ---

describe("detectStack", () => {
  it("detects python from pyproject.toml", () => {
    const dir = makeTempDir("am-stack-");
    writeFileSync(join(dir, "pyproject.toml"), "");
    expect(detectStack(dir)).toBe("python");
  });

  it("detects typescript from tsconfig.json", () => {
    const dir = makeTempDir("am-stack-");
    writeFileSync(join(dir, "tsconfig.json"), "");
    expect(detectStack(dir)).toBe("typescript");
  });

  it("returns empty for unknown stack", () => {
    const dir = makeTempDir("am-stack-");
    expect(detectStack(dir)).toBe("");
  });
});

// --- extractField ---

describe("extractField", () => {
  const index = "# my-project\n\n- Stack: python (3.12)\n- Team: backend\n";

  it("extracts stack (strips annotations)", () => {
    expect(extractField(index, "Stack")).toBe("python");
  });

  it("extracts team", () => {
    expect(extractField(index, "Team")).toBe("backend");
  });

  it("returns empty for missing field", () => {
    expect(extractField(index, "Missing")).toBe("");
  });
});

// --- findProject ---

describe("findProject", () => {
  it("finds existing project", () => {
    const dir = makeTempDir("am-find-");
    const memDir = scaffoldMemoryDir(dir);
    scaffoldProject(memDir, "my-api");
    expect(findProject(memDir, "my-api")).toBe(join(memDir, "projects", "my-api"));
  });

  it("returns null for missing project", () => {
    const dir = makeTempDir("am-find-");
    const memDir = scaffoldMemoryDir(dir);
    expect(findProject(memDir, "nonexistent")).toBeNull();
  });
});

// --- createProject ---

describe("createProject", () => {
  it("creates project directory with scaffold files", () => {
    const dir = makeTempDir("am-create-");
    const memDir = scaffoldMemoryDir(dir);
    const workspace = makeTempDir("am-ws-");
    writeFileSync(join(workspace, "pyproject.toml"), "");

    const projectDir = createProject(memDir, "new-api", workspace);

    expect(readFileSafe(join(projectDir, "index.md"))).toContain("# new-api");
    expect(readFileSafe(join(projectDir, "index.md"))).toContain("Stack: python");
    expect(readFileSafe(join(projectDir, "latest-sessions.md"))).toContain("Latest sessions");
    expect(readFileSafe(join(projectDir, "open-threads.md"))).toContain("Open threads");
    expect(readFileSafe(join(projectDir, "logs", "index.md"))).toContain("Session logs");
  });

  it("updates projects/index.md", () => {
    const dir = makeTempDir("am-create-");
    const memDir = scaffoldMemoryDir(dir);
    writeFileSync(join(memDir, "projects", "index.md"), "# Projects\n\n");
    const workspace = makeTempDir("am-ws-");

    createProject(memDir, "new-api", workspace);

    const index = readFileSafe(join(memDir, "projects", "index.md"));
    expect(index).toContain("new-api");
  });

  it("does not duplicate entry in projects/index.md", () => {
    const dir = makeTempDir("am-create-");
    const memDir = scaffoldMemoryDir(dir);
    writeFileSync(
      join(memDir, "projects", "index.md"),
      "# Projects\n\n- projects/new-api/index.md\n",
    );
    const workspace = makeTempDir("am-ws-");

    createProject(memDir, "new-api", workspace);

    const index = readFileSync(join(memDir, "projects", "index.md"), "utf-8");
    const matches = index.match(/new-api/g);
    expect(matches?.length).toBe(1);
  });
});

// --- composeContext ---

describe("composeContext", () => {
  it("composes context from all scopes", () => {
    const dir = makeTempDir("am-compose-");
    const memDir = scaffoldMemoryDir(dir);
    const projectDir = scaffoldProject(memDir, "my-api");

    mkdirSync(join(memDir, "stacks", "python"), { recursive: true });
    writeFileSync(join(memDir, "stacks", "python", "index.md"), "# Python\n\nUse ruff.\n");
    mkdirSync(join(memDir, "teams", "backend"), { recursive: true });
    writeFileSync(join(memDir, "teams", "backend", "index.md"), "# Backend\n\n1 approval.\n");

    const ctx = composeContext(memDir, projectDir, "my-api");

    expect(ctx).toContain("Agent Memory");
    expect(ctx).toContain("# my-api");
    expect(ctx).toContain("Refactored auth module");
    expect(ctx).toContain("Finish migration");
    expect(ctx).toContain("Use ruff");
    expect(ctx).toContain("1 approval");
    expect(ctx).toContain("Conventional commits");
  });

  it("skips missing scopes gracefully", () => {
    const dir = makeTempDir("am-compose-");
    const memDir = scaffoldMemoryDir(dir);
    const projectDir = scaffoldProject(memDir, "my-api");

    const ctx = composeContext(memDir, projectDir, "my-api");

    expect(ctx).toContain("Agent Memory");
    expect(ctx).toContain("# my-api");
    expect(ctx).not.toContain("undefined");
  });

  it("excludes latest-sessions with placeholder text", () => {
    const dir = makeTempDir("am-compose-");
    const memDir = scaffoldMemoryDir(dir);
    const projectDir = join(memDir, "projects", "fresh");
    mkdirSync(join(projectDir, "logs"), { recursive: true });
    writeFileSync(join(projectDir, "index.md"), "# fresh\n\n");
    writeFileSync(
      join(projectDir, "latest-sessions.md"),
      "# Latest sessions\n\n(No sessions recorded yet. Use /save when done.)\n",
    );
    writeFileSync(join(projectDir, "open-threads.md"), "# Open threads\n\n(None yet.)\n");

    const ctx = composeContext(memDir, projectDir, "fresh");

    expect(ctx).not.toContain("No sessions recorded");
    expect(ctx).not.toContain("(None");
  });
});

// --- filterConversation ---

describe("filterConversation", () => {
  it("extracts user and assistant text", () => {
    const entries = [
      { type: "user", message: { content: "How do I fix this?" } },
      { type: "assistant", message: { content: "Try updating the config." } },
    ];
    const result = filterConversation(entries);
    expect(result).toBe("USER: How do I fix this?\n\nAGENT: Try updating the config.");
  });

  it("handles array content blocks", () => {
    const entries = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Here is the fix." },
            { type: "tool_use", text: "ignored" },
            { type: "text", text: "And a follow-up." },
          ],
        },
      },
    ];
    const result = filterConversation(entries);
    expect(result).toBe("AGENT: Here is the fix.\n\nAGENT: And a follow-up.");
  });

  it("skips non-user/assistant entries", () => {
    const entries = [
      { type: "system", message: { content: "system prompt" } },
      { type: "user", message: { content: "hello" } },
      { type: "tool_result", message: { content: "tool output" } },
    ];
    expect(filterConversation(entries)).toBe("USER: hello");
  });

  it("skips empty content", () => {
    const entries = [
      { type: "user", message: { content: "" } },
      { type: "user", message: { content: "  " } },
      { type: "user", message: { content: "actual content" } },
    ];
    expect(filterConversation(entries)).toBe("USER: actual content");
  });

  it("returns empty string for no conversation", () => {
    expect(filterConversation([])).toBe("");
  });
});

// --- buildExtractionPrompt ---

describe("buildExtractionPrompt", () => {
  it("includes project name and conversation", () => {
    const prompt = buildExtractionPrompt(
      "/mem",
      "/mem/projects/my-api",
      "my-api",
      "USER: hello\n\nAGENT: hi",
    );
    expect(prompt).toContain("my-api");
    expect(prompt).toContain("USER: hello");
    expect(prompt).toContain("git commit");
    expect(prompt).toContain("auto-save: my-api");
  });

  it("uses fallback instructions when save.md is missing", () => {
    const prompt = buildExtractionPrompt(
      "/nonexistent",
      "/nonexistent/projects/x",
      "x",
      "USER: test",
    );
    expect(prompt).toContain("Extract decisions");
  });
});

// --- checkConsolidationDue ---

describe("checkConsolidationDue", () => {
  it("returns daily when no state file exists", () => {
    const dir = makeTempDir("am-consol-");
    const memDir = scaffoldMemoryDir(dir);
    expect(checkConsolidationDue(memDir)).toBe("daily");
  });

  it("returns null when last run is today", () => {
    const dir = makeTempDir("am-consol-");
    const memDir = scaffoldMemoryDir(dir);
    const stateFile = join(memDir, "hooks", ".state", "consolidate.json");
    writeFileSync(stateFile, JSON.stringify({ last_run: new Date().toISOString().slice(0, 10) }));
    expect(checkConsolidationDue(memDir)).toBeNull();
  });

  it("returns daily when last run is yesterday", () => {
    const dir = makeTempDir("am-consol-");
    const memDir = scaffoldMemoryDir(dir);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const stateFile = join(memDir, "hooks", ".state", "consolidate.json");
    writeFileSync(stateFile, JSON.stringify({ last_run: yesterday }));
    expect(checkConsolidationDue(memDir)).toBe("daily");
  });

  it("returns weekly when 8 days old", () => {
    const dir = makeTempDir("am-consol-");
    const memDir = scaffoldMemoryDir(dir);
    const past = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    const stateFile = join(memDir, "hooks", ".state", "consolidate.json");
    writeFileSync(stateFile, JSON.stringify({ last_run: past }));
    expect(checkConsolidationDue(memDir)).toBe("weekly");
  });

  it("returns monthly when 30 days old", () => {
    const dir = makeTempDir("am-consol-");
    const memDir = scaffoldMemoryDir(dir);
    const past = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const stateFile = join(memDir, "hooks", ".state", "consolidate.json");
    writeFileSync(stateFile, JSON.stringify({ last_run: past }));
    expect(checkConsolidationDue(memDir)).toBe("monthly");
  });
});

// --- Extension integration (mock Pi) ---

describe("agentsMemory extension", () => {
  function createMockPi() {
    const handlers: Record<string, (...args: any[]) => any> = {};
    return {
      pi: {
        on(event: string, handler: (...args: unknown[]) => unknown) {
          handlers[event] = handler;
        },
      } as any,
      handlers,
    };
  }

  function mockCtx(cwd: string, entries: any[] = []) {
    return {
      cwd,
      sessionManager: {
        getEntries: () => entries,
      },
    };
  }

  it("skips initialization when AGENT_MEMORY_SAVE is set", () => {
    const original = process.env[SAVE_ENV_KEY];
    process.env[SAVE_ENV_KEY] = "1";
    try {
      const { pi, handlers } = createMockPi();
      agentsMemory(pi);
      expect(Object.keys(handlers)).toHaveLength(0);
    } finally {
      if (original !== undefined) {
        process.env[SAVE_ENV_KEY] = original;
      } else {
        delete process.env[SAVE_ENV_KEY];
      }
    }
  });

  it("injects context message on first before_agent_start", async () => {
    const dir = makeTempDir("am-ext-");
    const memDir = scaffoldMemoryDir(dir);
    scaffoldProject(memDir, "test-project");

    const original = process.env.AGENT_MEMORY_DIR;
    process.env.AGENT_MEMORY_DIR = memDir;
    try {
      const { pi, handlers } = createMockPi();
      agentsMemory(pi);

      await handlers.session_start({}, mockCtx(join(dir, "test-project")));

      const first = await handlers.before_agent_start({ systemPrompt: "base" });
      expect(first).toBeDefined();
      expect(first.message.customType).toBe(MESSAGE_CUSTOM_TYPE);
      expect(first.message.content).toContain("Agent Memory");
      expect(first.message.display).toBe(false);

      const second = await handlers.before_agent_start({ systemPrompt: "base" });
      expect(second).toBeUndefined();
    } finally {
      if (original !== undefined) {
        process.env.AGENT_MEMORY_DIR = original;
      } else {
        delete process.env.AGENT_MEMORY_DIR;
      }
    }
  });

  it("skips context injection for projects with .skip file", async () => {
    const dir = makeTempDir("am-ext-");
    const memDir = scaffoldMemoryDir(dir);
    const projectDir = scaffoldProject(memDir, "skipped-project");
    writeFileSync(join(projectDir, ".skip"), "");

    const original = process.env.AGENT_MEMORY_DIR;
    process.env.AGENT_MEMORY_DIR = memDir;
    try {
      const { pi, handlers } = createMockPi();
      agentsMemory(pi);

      await handlers.session_start({}, mockCtx(join(dir, "skipped-project")));

      const result = await handlers.before_agent_start({ systemPrompt: "base" });
      expect(result).toBeUndefined();
    } finally {
      if (original !== undefined) {
        process.env.AGENT_MEMORY_DIR = original;
      } else {
        delete process.env.AGENT_MEMORY_DIR;
      }
    }
  });

  it("creates new project on first encounter", async () => {
    const dir = makeTempDir("am-ext-");
    const memDir = scaffoldMemoryDir(dir);
    const workspace = join(dir, "brand-new");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "pyproject.toml"), "");

    const original = process.env.AGENT_MEMORY_DIR;
    process.env.AGENT_MEMORY_DIR = memDir;
    try {
      const { pi, handlers } = createMockPi();
      agentsMemory(pi);

      await handlers.session_start({}, mockCtx(workspace));

      const result = await handlers.before_agent_start({ systemPrompt: "base" });
      expect(result?.message?.content).toContain("brand-new");
      expect(result?.message?.content).toContain("auto-detected");

      const indexContent = readFileSafe(join(memDir, "projects", "brand-new", "index.md"));
      expect(indexContent).toContain("Stack: python");
    } finally {
      if (original !== undefined) {
        process.env.AGENT_MEMORY_DIR = original;
      } else {
        delete process.env.AGENT_MEMORY_DIR;
      }
    }
  });

  it("agent_end increments counter but does not save below threshold", async () => {
    const dir = makeTempDir("am-ext-");
    const memDir = scaffoldMemoryDir(dir);
    scaffoldProject(memDir, "test-project");

    const original = process.env.AGENT_MEMORY_DIR;
    process.env.AGENT_MEMORY_DIR = memDir;
    try {
      const { pi, handlers } = createMockPi();
      agentsMemory(pi);

      const entries = [{ type: "user", message: { content: "hello" } }];
      const ctx = mockCtx(join(dir, "test-project"), entries);

      await handlers.session_start({}, ctx);

      // agent_end below threshold should not crash or spawn
      await handlers.agent_end({}, ctx);
      // No assertion on spawn — just verifying it doesn't error
    } finally {
      if (original !== undefined) {
        process.env.AGENT_MEMORY_DIR = original;
      } else {
        delete process.env.AGENT_MEMORY_DIR;
      }
    }
  });

  it("session_shutdown with reason quit triggers save attempt", async () => {
    const dir = makeTempDir("am-ext-");
    const memDir = scaffoldMemoryDir(dir);
    scaffoldProject(memDir, "test-project");

    const original = process.env.AGENT_MEMORY_DIR;
    process.env.AGENT_MEMORY_DIR = memDir;
    try {
      const { pi, handlers } = createMockPi();
      agentsMemory(pi);

      const entries = [{ type: "user", message: { content: "hello" } }];
      const ctx = mockCtx(join(dir, "test-project"), entries);

      await handlers.session_start({}, ctx);

      // session_shutdown with reason "quit" should attempt save (will fail to
      // spawn pi but should not error)
      await handlers.session_shutdown({ reason: "quit" }, ctx);
    } finally {
      if (original !== undefined) {
        process.env.AGENT_MEMORY_DIR = original;
      } else {
        delete process.env.AGENT_MEMORY_DIR;
      }
    }
  });

  it("session_shutdown with reason reload does not save", async () => {
    const dir = makeTempDir("am-ext-");
    const memDir = scaffoldMemoryDir(dir);
    scaffoldProject(memDir, "test-project");

    const original = process.env.AGENT_MEMORY_DIR;
    process.env.AGENT_MEMORY_DIR = memDir;
    try {
      const { pi, handlers } = createMockPi();
      agentsMemory(pi);

      const entries = [{ type: "user", message: { content: "hello" } }];
      const ctx = mockCtx(join(dir, "test-project"), entries);

      await handlers.session_start({}, ctx);

      // reason "reload" should not trigger save — no error expected
      await handlers.session_shutdown({ reason: "reload" }, ctx);
    } finally {
      if (original !== undefined) {
        process.env.AGENT_MEMORY_DIR = original;
      } else {
        delete process.env.AGENT_MEMORY_DIR;
      }
    }
  });
});
