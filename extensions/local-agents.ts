/**
 * Local Agents Extension
 *
 * Loads every project-local *_AGENTS.md file (LOCAL_AGENTS.md, TEAM_AGENTS.md,
 * PROJECT_AGENTS.md, ...). The plain AGENTS.md file is NOT matched: pi loads it
 * natively.
 *
 * Each matching file is:
 * 1. Injected into the system prompt on every turn (before_agent_start), so
 *    edits to a file take effect without reloading the session.
 * 2. Summarised in a boot notice rendered in the chat transcript at session
 *    start, alongside the Context/Skills/Prompts banner and other extensions'
 *    startup summaries.
 *
 * The boot notice is implemented as a custom session entry (pi.appendEntry +
 * pi.registerEntryRenderer) instead of ctx.ui.notify, because pi's notify
 * merges back-to-back status messages into the previous line to avoid log
 * spam: two extensions notifying at session start would silently overwrite
 * each other. Custom entries render through their own path and never collide.
 * They also do not participate in LLM context.
 *
 * The files stay out of version control: whenever the write or edit tool
 * touches a *_AGENTS.md file, the extension ensures the *_AGENTS.md pattern is
 * listed in the repository .gitignore. The same ensure runs at session start
 * as a backfill, so existing files are protected even before any tool edit.
 *
 * Install: copy to ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project)
 * Reload: /reload
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const AGENTS_FILE_SUFFIX = "_AGENTS.md";
const GITIGNORE_PATTERN = "*_AGENTS.md";
const NOTICE_CUSTOM_TYPE = "local-agents-notice";

/** A discovered *_AGENTS.md file with its parsed content. */
interface AgentsFile {
  /** Absolute path of the file. */
  absolutePath: string;
  /** File name including extension (basename). */
  name: string;
  /** Full file content. */
  content: string;
  /** Number of lines in the file. */
  lineCount: number;
}

/** Data stored in the boot notice session entry. */
interface LocalAgentsNoticeData {
  /** One summary line per loaded file, e.g. "LOCAL_AGENTS.md (3 lines)". */
  lines: string[];
}

/** Built-in tools that can modify file contents. */
const FILE_MODIFYING_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/**
 * Check whether a file name matches the *_AGENTS.md pattern (any non-empty
 * prefix before the suffix).
 *
 * @param name - File name to check
 * @returns True when the name ends in _AGENTS.md with a non-empty prefix
 */
function isAgentsFileName(name: string): boolean {
  return name.endsWith(AGENTS_FILE_SUFFIX) && name.length > AGENTS_FILE_SUFFIX.length;
}

/**
 * Count the lines of a text file.
 *
 * @param content - Text content of the file
 * @returns The number of lines
 */
function countLines(content: string): number {
  const trimmed = content.trimEnd();
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

/**
 * Walk upward from startDir looking for a .git marker (directory or file).
 *
 * @param startDir - Directory to start the search from
 * @returns The repository root, or undefined when no repository is found
 */
function findRepoRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Ensure the *_AGENTS.md pattern is present in the repository .gitignore.
 *
 * @param repoRoot - Root directory of the repository
 * @returns True when the .gitignore file was modified
 */
function ensureGitIgnored(repoRoot: string): boolean {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf8");
    const hasPattern = content.split("\n").some((line) => {
      const trimmed = line.trim();
      return trimmed === GITIGNORE_PATTERN || trimmed === `/${GITIGNORE_PATTERN}`;
    });
    if (hasPattern) {
      return false;
    }
  }
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(gitignorePath, `${content}${separator}${GITIGNORE_PATTERN}\n`);
  return true;
}

/**
 * Extract the path field from a write/edit tool input.
 *
 * @param input - Raw tool input from a tool_result event
 * @returns The target file path, or undefined when the input has no usable path
 */
function extractToolPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const candidate = (input as { path?: unknown }).path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Read one *_AGENTS.md file into an AgentsFile record.
 *
 * @param filePath - Absolute path of the candidate file
 * @returns The parsed file, or undefined when it cannot be read
 */
function readAgentsFile(filePath: string): AgentsFile | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  return {
    absolutePath: filePath,
    name: path.basename(filePath),
    content,
    lineCount: countLines(content),
  };
}

/**
 * Find every *_AGENTS.md file directly inside a directory (non-recursive).
 *
 * @param dir - Directory to scan
 * @returns The parsed files, sorted by file name
 */
function findAgentsFiles(dir: string): AgentsFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && isAgentsFileName(entry.name))
    .map((entry) => readAgentsFile(path.join(dir, entry.name)))
    .filter((file): file is AgentsFile => file !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the notice line for one loaded file, e.g. "TEAM_AGENTS.md (12 lines)".
 *
 * @param file - The parsed file
 * @returns The summary line
 */
function summarizeAgentsFile(file: AgentsFile): string {
  const lineLabel = file.lineCount === 1 ? "line" : "lines";
  return `${file.name} (${file.lineCount} ${lineLabel})`;
}

export default function localAgentsExtension(pi: ExtensionAPI) {
  let projectDir: string | undefined;
  let repoRoot: string | undefined;

  /**
   * Render the boot notice as a compact card in the chat transcript.
   *
   * @param entry - The session entry holding one summary line per file
   * @param _opts - Renderer options (unused)
   * @param theme - Active theme for styling
   * @returns The component to render
   */
  pi.registerEntryRenderer<LocalAgentsNoticeData>(NOTICE_CUSTOM_TYPE, (entry, _opts, theme) => {
    const lines = entry.data?.lines ?? [];
    const box = new Box(1, 1, (text) => text);
    box.addChild(new Text(theme.fg("accent", "[Additional Context]"), 0, 0));
    for (const line of lines) {
      box.addChild(new Text(`  ${line}`, 0, 0));
    }
    return box;
  });

  /**
   * Read every *_AGENTS.md file in the project directory.
   *
   * @returns The parsed files, or an empty array when the directory is unknown
   */
  const loadAgentFiles = (): AgentsFile[] => (projectDir ? findAgentsFiles(projectDir) : []);

  /**
   * Build the system prompt block that injects the *_AGENTS.md file contents
   * into the agent context.
   *
   * @param files - The parsed files to include
   * @returns The prompt block, or undefined when no files are loaded
   */
  const buildContextInjection = (files: AgentsFile[]): string | undefined => {
    if (files.length === 0) {
      return undefined;
    }
    const sections = files.map(
      (file) => `# From ${file.name}\n\n${file.content.trim()}\n`,
    );
    return [
      `The following *_AGENTS.md files from the project directory hold additional project instructions. Follow them alongside any AGENTS.md instructions.`,
      "",
      ...sections.map((section) => section.trimEnd()),
    ].join("\n");
  };

  // Resolve the base directory, backfill the .gitignore pattern when any
  // *_AGENTS.md file already exists, and append the boot notice as a custom
  // session entry (no pinned widget, no notify collision with other
  // extensions' startup summaries).
  pi.on("session_start", async (_event, ctx) => {
    try {
      repoRoot = findRepoRoot(ctx.cwd);
      projectDir = repoRoot ?? ctx.cwd;

      const files = loadAgentFiles();
      if (repoRoot && files.length > 0) {
        ensureGitIgnored(repoRoot);
      }

      if (files.length === 0) {
        return;
      }

      const alreadyShown = ctx.sessionManager
        .getEntries()
        .some((entry) => entry.type === "custom" && entry.customType === NOTICE_CUSTOM_TYPE);
      if (!alreadyShown) {
        pi.appendEntry<LocalAgentsNoticeData>(NOTICE_CUSTOM_TYPE, {
          lines: files.map(summarizeAgentsFile),
        });
      }
    } catch (error) {
      console.error("[local-agents] failed to show boot notice:", error);
    }
  });

  // Inject every *_AGENTS.md file into the system prompt for each turn.
  // Files are re-read on every turn, so edits apply without a session reload.
  pi.on("before_agent_start", async (event) => {
    try {
      const injection = buildContextInjection(loadAgentFiles());
      if (!injection) {
        return undefined;
      }
      return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
    } catch (error) {
      console.error("[local-agents] failed to inject context:", error);
      return undefined;
    }
  });

  // After any write or edit that touches a *_AGENTS.md file, keep the file
  // out of version control.
  pi.on("tool_result", async (event, ctx) => {
    if (!FILE_MODIFYING_TOOLS.has(event.toolName) || !repoRoot) {
      return;
    }

    const filePath = extractToolPath(event.input);
    if (!filePath) {
      return;
    }
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
    if (!isAgentsFileName(path.basename(absolutePath))) {
      return;
    }

    try {
      const gitignoreUpdated = ensureGitIgnored(repoRoot);
      if (gitignoreUpdated && ctx.hasUI) {
        ctx.ui.notify(`${path.basename(absolutePath)} added to .gitignore`, "info");
      }
    } catch (error) {
      console.error("[local-agents] failed to update .gitignore:", error);
    }
  });
}
