#!/usr/bin/env bun

/**
 * Session converter: Claude Code ↔ Copilot CLI
 *
 * Usage:
 *   agent-convert claude-to-copilot <claude-session-id>
 *   agent-convert copilot-to-claude <copilot-session-id>
 */

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { Database } from "bun:sqlite";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const COPILOT_DIR = join(homedir(), ".copilot", "session-state");

// ─── Claude → Copilot ──────────────────────────────────────────────────────────

interface ClaudeEntry {
  type: string;
  message?: { role: string; content: any; stop_reason?: string };
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  version?: string;
  gitBranch?: string;
  aiTitle?: string;
  lastPrompt?: string;
  [key: string]: any;
}

// Map Claude Code tool names to Copilot CLI equivalents
function mapToolNameClaudeToCopilot(name: string): string {
  const map: Record<string, string> = {
    Bash: "bash",
    Read: "view",
    Write: "create",
    Edit: "edit",
    MultiEdit: "edit",
    Glob: "glob",
    Grep: "grep",
    Agent: "task",
    AskUserQuestion: "ask_user",
    TodoRead: "sql",
    TodoWrite: "sql",
    TaskCreate: "sql",
    TaskUpdate: "sql",
  };
  return map[name] ?? name.toLowerCase();
}

// Map tool input field names
function mapToolInputClaudeToCopilot(name: string, input: Record<string, any>): Record<string, any> {
  switch (name) {
    case "Bash":
      return { command: input.command, description: input.description ?? "" };
    case "Read":
      return { path: input.file_path };
    case "Write":
      return { path: input.file_path, file_text: input.content };
    case "Edit":
      return { path: input.file_path, old_str: input.old_string, new_str: input.new_string };
    case "Glob":
      return { pattern: input.pattern, paths: input.path };
    case "Grep":
      return { pattern: input.pattern, paths: input.path, glob: input.include };
    default:
      return input;
  }
}

async function findClaudeSession(sessionIdOrPrefix: string): Promise<string | null> {
  const dirs = await readdir(CLAUDE_PROJECTS_DIR);
  for (const dir of dirs) {
    const projectPath = join(CLAUDE_PROJECTS_DIR, dir);
    try {
      const files = await readdir(projectPath);
      for (const file of files) {
        if (file.endsWith(".jsonl") && file.startsWith(sessionIdOrPrefix)) {
          return join(projectPath, file);
        }
      }
    } catch {}
  }
  return null;
}

async function claudeToCopilot(sessionId: string): Promise<string> {
  const filePath = await findClaudeSession(sessionId);
  if (!filePath) throw new Error(`Claude session not found: ${sessionId}`);

  const raw = await readFile(filePath, "utf-8");
  const entries: ClaudeEntry[] = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean) as ClaudeEntry[];

  // Extract metadata
  let cwd = "";
  let sessionTitle = "";
  let gitBranch = "";
  let claudeSessionId = "";

  for (const e of entries) {
    if (e.cwd && !cwd) cwd = e.cwd;
    if (e.sessionId && !claudeSessionId) claudeSessionId = e.sessionId;
    if (e.gitBranch && !gitBranch) gitBranch = e.gitBranch;
    if (e.type === "ai-title" && e.aiTitle) sessionTitle = e.aiTitle;
  }

  // Generate new copilot session ID
  const newSessionId = randomUUID();
  const sessionDir = join(COPILOT_DIR, newSessionId);
  await mkdir(sessionDir, { recursive: true });
  await mkdir(join(sessionDir, "checkpoints"), { recursive: true });
  await mkdir(join(sessionDir, "files"), { recursive: true });
  await mkdir(join(sessionDir, "research"), { recursive: true });

  // Write workspace.yaml
  const now = new Date().toISOString();
  const wsYaml = [
    `id: ${newSessionId}`,
    `cwd: ${cwd}`,
    `name: ${sessionTitle || "Converted from Claude Code"}`,
    `user_named: false`,
    `summary_count: 0`,
    `created_at: ${entries[0]?.timestamp ?? now}`,
    `updated_at: ${entries[entries.length - 1]?.timestamp ?? now}`,
    ...(gitBranch ? [`branch: ${gitBranch}`] : []),
  ].join("\n") + "\n";
  await writeFile(join(sessionDir, "workspace.yaml"), wsYaml);

  // Write vscode.metadata.json
  await writeFile(
    join(sessionDir, "vscode.metadata.json"),
    JSON.stringify({ origin: "converted-from-claude", modified: Date.now(), created: Date.now() })
  );

  // Write empty checkpoints/index.md
  await writeFile(
    join(sessionDir, "checkpoints", "index.md"),
    "# Checkpoint History\n\nCheckpoints are listed in chronological order. Checkpoint 1 is the oldest, higher numbers are more recent.\n\n| # | Title | File |\n|---|-------|------|\n"
  );

  // Create session.db with empty tables
  const db = new Database(join(sessionDir, "session.db"));
  db.run(`CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'blocked')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS todo_deps (
    todo_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    PRIMARY KEY (todo_id, depends_on),
    FOREIGN KEY (todo_id) REFERENCES todos(id),
    FOREIGN KEY (depends_on) REFERENCES todos(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS inbox_entries (
    id TEXT PRIMARY KEY,
    recipient_session_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL,
    content TEXT NOT NULL,
    unread INTEGER NOT NULL DEFAULT 1,
    sent_at INTEGER NOT NULL,
    read_at INTEGER,
    notified_at INTEGER
  )`);
  db.close();

  // Build events.jsonl
  const events: string[] = [];
  let parentId: string | null = null;

  function emit(event: Record<string, any>): void {
    const id = randomUUID();
    events.push(JSON.stringify({ ...event, id, timestamp: event.timestamp ?? now, parentId }));
    parentId = id;
  }

  // session.start
  const startTs = entries.find((e) => e.timestamp)?.timestamp ?? now;
  emit({
    type: "session.start",
    data: {
      sessionId: newSessionId,
      version: 1,
      producer: "copilot-agent",
      copilotVersion: "1.0.49",
      startTime: startTs,
      context: { cwd },
      alreadyInUse: false,
      remoteSteerable: false,
    },
    timestamp: startTs,
  });

  // Process conversation entries
  let interactionId = randomUUID();
  let turnIdx = 0;

  for (const entry of entries) {
    const ts = entry.timestamp ?? now;

    if (entry.type === "user") {
      const content = entry.message?.content;
      if (!content) continue;

      // Only emit user.message for real text prompts (not tool_results)
      if (typeof content === "string") {
        interactionId = randomUUID();
        turnIdx = 0;
        emit({ type: "user.message", data: { content }, timestamp: ts });
        emit({ type: "assistant.turn_start", data: { turnId: String(turnIdx), interactionId }, timestamp: ts });
      } else if (Array.isArray(content)) {
        const hasText = content.some((b: any) => b.type === "text");
        const hasToolResult = content.some((b: any) => b.type === "tool_result");

        if (hasText && !hasToolResult) {
          const text = content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n");
          interactionId = randomUUID();
          turnIdx = 0;
          emit({ type: "user.message", data: { content: text }, timestamp: ts });
          emit({ type: "assistant.turn_start", data: { turnId: String(turnIdx), interactionId }, timestamp: ts });
        }

        // Emit tool execution completions for tool_results
        if (hasToolResult) {
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            const resultContent = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b: any) => b.text ?? "").join("")
                : "";
            emit({
              type: "tool.execution_complete",
              data: {
                toolCallId: block.tool_use_id,
                model: "claude-sonnet-4-6",
                interactionId,
                turnId: String(turnIdx),
                success: !block.is_error,
                result: { content: resultContent },
                toolTelemetry: {},
              },
              timestamp: ts,
            });
          }
        }
      }
    }

    if (entry.type === "assistant") {
      const msg = entry.message;
      if (!msg) continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      // Build toolRequests from tool_use blocks
      const toolRequests: any[] = [];
      let textContent = "";

      for (const block of content) {
        if (block.type === "tool_use") {
          const copilotName = mapToolNameClaudeToCopilot(block.name);
          const copilotArgs = mapToolInputClaudeToCopilot(block.name, block.input ?? {});
          toolRequests.push({
            toolCallId: block.id,
            name: copilotName,
            arguments: copilotArgs,
            type: "function",
          });
        } else if (block.type === "text") {
          textContent += (block.text ?? "") + "\n";
        }
      }

      emit({
        type: "assistant.message",
        data: {
          messageId: randomUUID(),
          model: "claude-sonnet-4-6",
          content: textContent.trim(),
          toolRequests,
          interactionId,
          turnId: String(turnIdx),
          outputTokens: 0,
        },
        timestamp: ts,
      });

      // Emit tool.execution_start for each tool request
      for (const tr of toolRequests) {
        emit({
          type: "tool.execution_start",
          data: {
            toolCallId: tr.toolCallId,
            toolName: tr.name,
            arguments: tr.arguments,
            turnId: String(turnIdx),
          },
          timestamp: ts,
        });
      }

      // If stop_reason is end_turn (no tool calls pending), emit turn_end
      if (msg.stop_reason === "end_turn" || (msg.stop_reason === "stop_sequence" && toolRequests.length === 0)) {
        emit({ type: "assistant.turn_end", data: { turnId: String(turnIdx) }, timestamp: ts });
        turnIdx++;
        // Start next turn if there are more messages
        emit({ type: "assistant.turn_start", data: { turnId: String(turnIdx), interactionId }, timestamp: ts });
      } else if (toolRequests.length === 0) {
        // Text-only response, end the turn
        emit({ type: "assistant.turn_end", data: { turnId: String(turnIdx) }, timestamp: ts });
        turnIdx++;
      }
    }
  }

  await writeFile(join(sessionDir, "events.jsonl"), events.join("\n") + "\n");

  return newSessionId;
}

// ─── Copilot → Claude ──────────────────────────────────────────────────────────

// Map Copilot CLI tool names to Claude Code equivalents
function mapToolNameCopilotToClaude(name: string): string {
  const map: Record<string, string> = {
    bash: "Bash",
    view: "Read",
    create: "Write",
    edit: "Edit",
    glob: "Glob",
    grep: "Grep",
    task: "Agent",
    ask_user: "AskUserQuestion",
    sql: "TodoWrite",
    report_intent: "TodoWrite", // no direct equivalent, map to something benign
  };
  return map[name] ?? name;
}

function mapToolInputCopilotToClaude(name: string, input: Record<string, any>): Record<string, any> {
  switch (name) {
    case "bash":
      return { command: input.command };
    case "view":
      return { file_path: input.path, view_range: input.view_range };
    case "create":
      return { file_path: input.path, content: input.file_text };
    case "edit":
      return { file_path: input.path, old_string: input.old_str, new_string: input.new_str };
    case "glob":
      return { pattern: input.pattern, path: input.paths };
    case "grep":
      return { pattern: input.pattern, path: input.paths, include: input.glob };
    default:
      return input;
  }
}

function parseWorkspaceYaml(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

async function copilotToClaude(sessionId: string): Promise<{ id: string; cwd: string }> {
  // Find the session dir (support prefix matching)
  let sessionDir = join(COPILOT_DIR, sessionId);
  if (!existsSync(sessionDir)) {
    const dirs = await readdir(COPILOT_DIR);
    const match = dirs.find((d) => d.startsWith(sessionId));
    if (!match) throw new Error(`Copilot session not found: ${sessionId}`);
    sessionDir = join(COPILOT_DIR, match);
    sessionId = match;
  }

  const wsRaw = await readFile(join(sessionDir, "workspace.yaml"), "utf-8");
  const ws = parseWorkspaceYaml(wsRaw);
  const eventsRaw = await readFile(join(sessionDir, "events.jsonl"), "utf-8");

  const events = eventsRaw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const cwd = ws.cwd || "/tmp";
  const sessionTitle = ws.name || "Converted from Copilot CLI";
  const gitBranch = ws.branch || "HEAD";
  const newSessionId = randomUUID();

  // Determine Claude projects dir name from cwd
  const projectDirName = "-" + cwd.replace(/[\/\.]/g, "-").replace(/^-/, "");
  const projectDir = join(CLAUDE_PROJECTS_DIR, projectDirName);
  await mkdir(projectDir, { recursive: true });

  const outputPath = join(projectDir, `${newSessionId}.jsonl`);
  const lines: string[] = [];

  function emit(entry: Record<string, any>): void {
    lines.push(JSON.stringify(entry));
  }

  // Opening entries
  const startTs = events[0]?.timestamp ?? new Date().toISOString();

  // Collect tool results keyed by toolCallId (pre-scan)
  const toolResults = new Map<string, { content: string; success: boolean; ts: string }>();
  for (const evt of events) {
    if (evt.type === "tool.execution_complete") {
      const d = evt.data;
      toolResults.set(d.toolCallId, {
        content: d.result?.content ?? "",
        success: d.success !== false,
        ts: evt.timestamp,
      });
    }
  }

  // Process events into Claude entries
  let lastUuid: string | null = null;
  let promptId = randomUUID();
  let lastUserPrompt = "";

  for (const evt of events) {
    const ts = evt.timestamp ?? startTs;

    if (evt.type === "user.message") {
      const content = evt.data?.content ?? "";
      if (!content) continue;

      promptId = randomUUID();
      const uuid = randomUUID();
      emit({
        parentUuid: lastUuid,
        isSidechain: false,
        promptId,
        type: "user",
        message: { role: "user", content },
        uuid,
        timestamp: ts,
        permissionMode: "default",
        userType: "external",
        entrypoint: "cli",
        cwd,
        sessionId: newSessionId,
        version: "2.1.145",
        gitBranch,
      });
      lastUuid = uuid;
      lastUserPrompt = content.slice(0, 200);
    }

    if (evt.type === "assistant.message") {
      const d = evt.data;
      const toolRequests: any[] = d.toolRequests ?? [];
      const textContent = d.content ?? "";

      // Build content blocks
      const contentBlocks: any[] = [];

      if (textContent) {
        contentBlocks.push({ type: "text", text: textContent });
      }

      for (const tr of toolRequests) {
        const claudeName = mapToolNameCopilotToClaude(tr.name);
        const claudeInput = mapToolInputCopilotToClaude(tr.name, tr.arguments ?? {});
        contentBlocks.push({
          type: "tool_use",
          id: tr.toolCallId,
          name: claudeName,
          input: claudeInput,
        });
      }

      if (contentBlocks.length === 0) continue;

      const stopReason = toolRequests.length > 0 ? "tool_use" : "end_turn";
      const model = d.model ?? "claude-sonnet-4-6";
      const uuid = randomUUID();
      emit({
        parentUuid: lastUuid,
        isSidechain: false,
        type: "assistant",
        message: {
          model,
          id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "message",
          role: "assistant",
          content: contentBlocks,
          stop_reason: stopReason,
          stop_sequence: null,
        },
        uuid,
        timestamp: ts,
        userType: "external",
        entrypoint: "cli",
        cwd,
        sessionId: newSessionId,
        version: "2.1.145",
        gitBranch,
      });
      lastUuid = uuid;

      // Emit tool_results as a user entry
      if (toolRequests.length > 0) {
        const resultBlocks: any[] = [];
        for (const tr of toolRequests) {
          const result = toolResults.get(tr.toolCallId);
          const isError = result ? !result.success : false;
          const content = result?.content ?? "";
          resultBlocks.push({
            type: "tool_result",
            tool_use_id: tr.toolCallId,
            content: isError && !content ? "Error" : content,
            is_error: isError,
          });
        }

        const firstResult = toolResults.get(toolRequests[0]?.toolCallId);
        const stdout = firstResult?.content ?? "";
        const resultUuid = randomUUID();
        emit({
          parentUuid: lastUuid,
          isSidechain: false,
          promptId,
          type: "user",
          message: { role: "user", content: resultBlocks },
          uuid: resultUuid,
          timestamp: ts,
          toolUseResult: { stdout, stderr: "", interrupted: false, isImage: false },
          sourceToolAssistantUUID: lastUuid,
          userType: "external",
          entrypoint: "cli",
          cwd,
          sessionId: newSessionId,
          version: "2.1.145",
          gitBranch,
        });
        lastUuid = resultUuid;
      }
    }
  }

  // Closing entries: last-prompt must have a valid leafUuid
  emit({
    type: "last-prompt",
    lastPrompt: lastUserPrompt || sessionTitle,
    leafUuid: lastUuid,
    sessionId: newSessionId,
  });
  emit({ type: "ai-title", aiTitle: sessionTitle, sessionId: newSessionId });

  await writeFile(outputPath, lines.join("\n") + "\n");
  return { id: newSessionId, cwd };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [, , direction, sessionId] = process.argv;

  if (!direction || !sessionId) {
    console.error("Usage:");
    console.error("  agent-convert claude-to-copilot <claude-session-id>");
    console.error("  agent-convert copilot-to-claude <copilot-session-id>");
    process.exit(1);
  }

  try {
    if (direction === "claude-to-copilot") {
      const newId = await claudeToCopilot(sessionId);
      console.log(`✓ Converted Claude → Copilot`);
      console.log(`  New session: ${newId}`);
      console.log(`  Location: ${join(COPILOT_DIR, newId)}`);
      console.log(`  Resume: copilot --resume=${newId}`);
    } else if (direction === "copilot-to-claude") {
      const { id: newId, cwd } = await copilotToClaude(sessionId);
      console.log(`✓ Converted Copilot → Claude`);
      console.log(`  New session: ${newId}`);
      console.log(`  Resume: cd ${cwd} && claude --resume ${newId}`);
    } else {
      console.error(`Unknown direction: ${direction}`);
      console.error("Use 'claude-to-copilot' or 'copilot-to-claude'");
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
