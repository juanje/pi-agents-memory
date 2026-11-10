/**
 * Pi Agents Memory Extension
 *
 * Cross-session persistent memory for Pi agents.
 * Loads project context at session start, auto-saves at session end.
 *
 * Runtime dependency: ~/agents-memory/ (or $AGENT_MEMORY_DIR)
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_SAVE_THRESHOLD = 10;
const MESSAGE_CUSTOM_TYPE = "agents-memory";
const SAVE_ENV_KEY = "AGENT_MEMORY_SAVE";

const RULES = `## Agent Memory

You have persistent memory for this project at ~/agents-memory/.
Context was loaded automatically (see below). You already know the
structure — navigate directly to the file you need, don't grep or search.

Memory paths:
- ~/agents-memory/projects/{project}/index.md — this project's context, decisions, logs
- ~/agents-memory/stacks/{stack}/index.md — stack-level standards and patterns
- ~/agents-memory/global/preferences.md — general preferences

To persist this session's work, use /save when you're done.

If the user corrects something about the project, stack, or preferences
("we don't do X anymore", "add Y to our standards", "that's wrong"),
update the relevant memory file immediately — don't wait for /save.
Memory corrections are system maintenance and happen inline.

If this is a NEW project (you see "[auto-detected — confirm with user]"
or "[ask user]" in the project index below), briefly confirm the stack
and team with the user at the start, then update the index.md.
`;

// --- File helpers ---

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getMemoryDir(): string {
  return process.env.AGENT_MEMORY_DIR ?? join(homedir(), "agents-memory");
}

// --- Stack detection ---

const STACK_MARKERS: Record<string, string[]> = {
  python: ["pyproject.toml", "setup.py", "requirements.txt"],
  typescript: ["package.json", "tsconfig.json"],
  go: ["go.mod"],
  rust: ["Cargo.toml"],
  java: ["pom.xml", "build.gradle"],
};

function detectStack(projectDir: string): string {
  for (const [stack, markers] of Object.entries(STACK_MARKERS)) {
    for (const marker of markers) {
      if (existsSync(join(projectDir, marker))) return stack;
    }
  }
  return "";
}

// --- Project management ---

function extractField(indexContent: string, field: string): string {
  for (const line of indexContent.split("\n")) {
    if (line.trim().startsWith(`- ${field}:`)) {
      let value = line.split(":", 2)[1]?.trim() ?? "";
      if (field === "Stack") {
        value = value
          .split("(")[0]
          .split("[")[0]
          .trim()
          .split(",")[0]
          // Stack can be free text like "TypeScript/Markdown memory tooling";
          // only the first path segment is the directory name.
          .split("/")[0]
          .trim()
          .toLowerCase();
      }
      return value;
    }
  }
  return "";
}

function findProject(memoryDir: string, name: string): string | null {
  const dir = join(memoryDir, "projects", name);
  if (existsSync(join(dir, "index.md"))) return dir;
  return null;
}

function createProject(memoryDir: string, name: string, workspaceDir: string): string {
  const dir = join(memoryDir, "projects", name);
  mkdirSync(join(dir, "logs"), { recursive: true });

  const stack = detectStack(workspaceDir);

  let indexContent = `# ${name}\n\n`;
  if (stack) indexContent += `- Stack: ${stack} [auto-detected — confirm with user]\n`;
  indexContent +=
    "- Team: [ask user]\n" +
    "- Last session: (new project)\n\n" +
    "Files:\n" +
    "- latest-sessions.md — summaries of the most recent sessions\n" +
    "- open-threads.md — unfinished work, pending questions\n" +
    "- logs/index.md — session history\n";

  writeFileSync(join(dir, "index.md"), indexContent);
  writeFileSync(
    join(dir, "latest-sessions.md"),
    "# Latest sessions\n\n(No sessions recorded yet. Use /save when done.)\n",
  );
  writeFileSync(join(dir, "open-threads.md"), "# Open threads\n\n(None yet.)\n");
  writeFileSync(
    join(dir, "logs", "index.md"),
    `# Session logs — ${name}\n\n| Date | Summary |\n|---|---|\n`,
  );

  const projectsIndex = join(memoryDir, "projects", "index.md");
  let entry = `- projects/${name}/index.md — (new project)`;
  if (stack) entry += ` (${stack})`;
  entry += "\n";

  if (existsSync(projectsIndex)) {
    const current = readFileSafe(projectsIndex);
    if (!current.includes(name)) {
      writeFileSync(projectsIndex, `${current.trimEnd()}\n${entry}`);
    }
  } else {
    writeFileSync(projectsIndex, `# Projects\n\n${entry}`);
  }

  return dir;
}

// --- Context composition ---

function composeContext(memoryDir: string, projectDir: string, projectName: string): string {
  const projectIndex = readFileSafe(join(projectDir, "index.md"));
  const stack = extractField(projectIndex, "Stack");
  const team = extractField(projectIndex, "Team");

  let rules = RULES.replaceAll("{project}", projectName);
  if (stack) {
    rules = rules.replaceAll("{stack}", stack);
  } else {
    rules = rules
      .split("\n")
      .filter((line) => !line.includes("{stack}"))
      .join("\n");
  }

  const parts: string[] = [rules, "---\n"];

  if (projectIndex) parts.push(projectIndex, "");

  const latestSessions = readFileSafe(join(projectDir, "latest-sessions.md"));
  if (latestSessions && !latestSessions.includes("No sessions recorded")) {
    parts.push(latestSessions, "");
  }

  const context = readFileSafe(join(projectDir, "context.md"));
  if (context) parts.push(context, "");

  const openThreads = readFileSafe(join(projectDir, "open-threads.md"));
  if (openThreads && !openThreads.includes("(None")) parts.push(openThreads, "");

  if (stack) {
    const stackIndex = readFileSafe(join(memoryDir, "stacks", stack, "index.md"));
    if (stackIndex) parts.push(stackIndex, "");
  }

  if (team) {
    const teamIndex = readFileSafe(join(memoryDir, "teams", team, "index.md"));
    if (teamIndex) parts.push(teamIndex, "");
  }

  const prefs = readFileSafe(join(memoryDir, "global", "preferences.md"));
  if (prefs) parts.push(prefs);

  return parts.join("\n");
}

// --- Conversation filtering ---

interface SessionEntry {
  type: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
}

function filterConversation(entries: SessionEntry[]): string {
  const parts: string[] = [];

  for (const entry of entries) {
    // Real Pi entries store messages as { type: "message", message: { role, content } }
    if (entry.type !== "message") continue;

    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = entry.message?.content;
    const prefix = role === "user" ? "USER" : "AGENT";

    if (typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed) parts.push(`${prefix}: ${trimmed}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          parts.push(`${prefix}: ${block.text.trim()}`);
        }
      }
    }
  }

  return parts.join("\n\n");
}

// --- Consolidation ---

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkConsolidationDue(memoryDir: string): string | null {
  const stateFile = join(memoryDir, "hooks", ".state", "consolidate.json");
  const state = readJson(stateFile);

  const runningPid = state.running_pid;
  if (typeof runningPid === "number" && isPidAlive(runningPid)) return null;

  const lastRunStr = state.last_run;
  if (typeof lastRunStr !== "string" || !lastRunStr) return "daily";

  const lastRun = new Date(lastRunStr);
  if (Number.isNaN(lastRun.getTime())) return "daily";

  const days = Math.floor((Date.now() - lastRun.getTime()) / 86_400_000);
  if (days >= 28) return "monthly";
  if (days >= 7) return "weekly";
  if (days >= 1) return "daily";
  return null;
}

function launchConsolidation(memoryDir: string, cycle: string): void {
  const instructions = readFileSafe(join(memoryDir, "commands", "consolidate.md"));
  if (!instructions) return;

  const prompt =
    `Run a ${cycle} consolidation on the memory system at ${memoryDir}/. ` +
    `Follow these instructions:\n\n${instructions}`;

  const env = { ...process.env, [SAVE_ENV_KEY]: "1" };
  try {
    const child = spawn("pi", ["-p", prompt, "--tools", "read,write,edit,bash"], {
      cwd: memoryDir,
      env,
      stdio: "ignore",
      detached: true,
    });
    child.unref();

    const stateDir = join(memoryDir, "hooks", ".state");
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, "consolidate.json");
    const state = readJson(stateFile);
    state.running_pid = child.pid;
    writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
  } catch {
    // pi CLI not available — skip silently
  }
}

// --- Auto-save ---

function launchExtraction(memoryDir: string, prompt: string, projectName: string): boolean {
  const lockFile = join(memoryDir, "hooks", ".state", `${projectName}.lock`);
  if (existsSync(lockFile)) {
    try {
      const lockData = readJson(lockFile);
      if (typeof lockData.pid === "number" && isPidAlive(lockData.pid)) return false;
    } catch {
      // stale lock — proceed
    }
  }

  const env = { ...process.env, [SAVE_ENV_KEY]: "1" };
  try {
    const child = spawn("pi", ["-p", prompt, "--tools", "read,write,edit,bash"], {
      cwd: memoryDir,
      env,
      stdio: "ignore",
      detached: true,
    });
    child.unref();

    const stateDir = join(memoryDir, "hooks", ".state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(lockFile, `${JSON.stringify({ pid: child.pid })}\n`);
    return true;
  } catch {
    return false;
  }
}

function buildExtractionPrompt(
  memoryDir: string,
  projectDir: string,
  projectName: string,
  conversation: string,
): string {
  let saveInstructions = readFileSafe(join(memoryDir, "commands", "save.md"));
  if (!saveInstructions) {
    saveInstructions =
      "Extract decisions, corrections, learnings, and open threads. " +
      "Write to latest-sessions.md, open-threads.md, and logs/.";
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    `You are a memory extraction agent for the project '${projectName}'. ` +
    `The project memory is at ${projectDir}/.\n\n` +
    `Follow these instructions:\n\n${saveInstructions}\n\n` +
    `Apply them to the following conversation transcript:\n\n` +
    `--- CONVERSATION ---\n${conversation}\n--- END ---\n\n` +
    `After writing, run: cd ${memoryDir} && ` +
    `git add projects/${projectName}/ && ` +
    `git commit -m "auto-save: ${projectName} ${today}"\n`
  );
}

// --- Extension entry point ---

export default function agentsMemory(pi: ExtensionAPI) {
  if (process.env[SAVE_ENV_KEY] === "1") return;

  const memoryDir = getMemoryDir();
  if (!existsSync(memoryDir)) return;

  let context = "";
  let messageInjected = false;
  let projectName = "";
  let projectDir = "";
  let messageCount = 0;
  let lastSaveAt = 0;
  let threshold = DEFAULT_SAVE_THRESHOLD;

  function resetState() {
    context = "";
    messageInjected = false;
    projectName = "";
    projectDir = "";
    messageCount = 0;
    lastSaveAt = 0;
  }

  function doSave(ctx: { sessionManager: { getEntries(): unknown[] } }) {
    if (!projectDir) return;

    const entries = ctx.sessionManager.getEntries() as unknown as SessionEntry[];
    const conversation = filterConversation(entries);
    if (!conversation) return;

    const prompt = buildExtractionPrompt(memoryDir, projectDir, projectName, conversation);
    launchExtraction(memoryDir, prompt, projectName);
    lastSaveAt = messageCount;
  }

  pi.on("session_start", async (_event, ctx) => {
    resetState();

    const config = readJson(join(memoryDir, "config.json"));
    threshold =
      typeof config.auto_save_threshold === "number"
        ? config.auto_save_threshold
        : DEFAULT_SAVE_THRESHOLD;

    projectName = basename(ctx.cwd);
    const found = findProject(memoryDir, projectName);
    projectDir = found ?? createProject(memoryDir, projectName, ctx.cwd);

    if (existsSync(join(projectDir, ".skip"))) {
      projectDir = "";
      return;
    }

    context = composeContext(memoryDir, projectDir, projectName);

    const cycle = checkConsolidationDue(memoryDir);
    if (cycle) launchConsolidation(memoryDir, cycle);
  });

  pi.on("before_agent_start", async (_event) => {
    if (!context || messageInjected) return;
    messageInjected = true;
    return { message: { customType: MESSAGE_CUSTOM_TYPE, content: context, display: false } };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!projectDir) return;
    messageCount++;
    if (messageCount - lastSaveAt < threshold) return;
    doSave(ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (!projectDir) return;
    if (event.reason !== "quit") return;
    doSave(ctx);
  });

  // Save before compaction discards context. session_compact fires after the
  // compaction is applied (entries already trimmed), so it's too late there.
  pi.on("session_before_compact", async (_event, ctx) => {
    if (!projectDir) return;
    doSave(ctx);
  });
}

export {
  buildExtractionPrompt,
  checkConsolidationDue,
  composeContext,
  createProject,
  DEFAULT_SAVE_THRESHOLD,
  detectStack,
  extractField,
  filterConversation,
  findProject,
  getMemoryDir,
  isPidAlive,
  MESSAGE_CUSTOM_TYPE,
  RULES,
  readFileSafe,
  readJson,
  SAVE_ENV_KEY,
  STACK_MARKERS,
};
