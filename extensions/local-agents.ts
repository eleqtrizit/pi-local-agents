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
 * Nothing is added to .gitignore automatically. Instead, two slash commands
 * let the user opt in per file name or pattern:
 *   /local-agents-local-ignore <file name|pattern>   repository .gitignore
 *   /local-agents-global-ignore <file name|pattern>  global Git exclude file
 *
 * The boot notice is implemented as a custom session entry (pi.appendEntry +
 * pi.registerEntryRenderer) instead of ctx.ui.notify, because pi's notify
 * merges back-to-back status messages into the previous line to avoid log
 * spam: two extensions notifying at session start would silently overwrite
 * each other. Custom entries render through their own path and never collide.
 * They also do not participate in LLM context.
 *
 * Install: copy to ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project)
 * Reload: /reload
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const AGENTS_FILE_SUFFIX = "_AGENTS.md";
const DEFAULT_IGNORE_PATTERN = "*_AGENTS.md";
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
 * Add an ignore pattern to a Git ignore file, creating the file (and its
 * parent directory) when needed. Idempotent: an already-present pattern is
 * not added twice.
 *
 * @param ignoreFilePath - Path of the ignore file to update
 * @param pattern - File name or pattern to ignore
 * @returns True when the file was written, false when the pattern was already present
 * @throws When the ignore file cannot be read or written
 */
function addIgnorePattern(ignoreFilePath: string, pattern: string): boolean {
  let content = "";
  if (fs.existsSync(ignoreFilePath)) {
    content = fs.readFileSync(ignoreFilePath, "utf8");
    const hasPattern = content.split("\n").some((line) => {
      const trimmed = line.trim();
      return trimmed === pattern || trimmed === `/${pattern}`;
    });
    if (hasPattern) {
      return false;
    }
  }

  fs.mkdirSync(path.dirname(ignoreFilePath), { recursive: true });
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(ignoreFilePath, `${content}${separator}${pattern}\n`);
  return true;
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

/**
 * Extract the ignore pattern from a command's raw arguments. Quotes are
 * stripped so shell-style quoting works; pass nothing to get the default
 * *_AGENTS.md pattern.
 *
 * @param args - Raw command arguments
 * @returns The ignore pattern, or undefined when arguments are empty or only quotes
 */
function parseIgnorePattern(args: string): string | undefined {
  const trimmed = args.trim().replace(/^["'](.*)["']$/, "$1").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the global Git exclude file path: the core.excludesfile setting
 * when configured, otherwise Git's default ~/.config/git/ignore.
 *
 * @param pi - Extension API, used to run git config
 * @returns Absolute path of the global ignore file
 */
async function resolveGlobalIgnoreFile(pi: ExtensionAPI): Promise<string> {
  const { stdout, code } = await pi.exec("git", ["config", "--global", "core.excludesfile"]);
  const configured = code === 0 ? stdout.trim() : "";
  if (configured.length > 0) {
    return configured.startsWith("~")
      ? path.join(os.homedir(), configured.slice(1))
      : path.resolve(configured);
  }
  return path.join(os.homedir(), ".config", "git", "ignore");
}

export default function localAgentsExtension(pi: ExtensionAPI) {
  let projectDir: string | undefined;

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
    const sections = files.map((file) => `# From ${file.name}\n\n${file.content.trim()}\n`);
    return [
      `The following *_AGENTS.md files from the project directory hold additional project instructions. Follow them alongside any AGENTS.md instructions.`,
      "",
      ...sections.map((section) => section.trimEnd()),
    ].join("\n");
  };

  // Resolve the base directory and append the boot notice as a custom session
  // entry (no pinned widget, no notify collision with other extensions'
  // startup summaries). The repository root is resolved lazily by the
  // /local-agents-local-ignore command, which needs it only when invoked.
  pi.on("session_start", async (_event, ctx) => {
    try {
      projectDir = findRepoRoot(ctx.cwd) ?? ctx.cwd;

      const files = loadAgentFiles();
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

  /**
   * Shared handler body: parse the pattern and add it to the given ignore
   * file. The notify target file path is included in the result message.
   *
   * @param args - Raw command arguments
   * @param ctx - Extension context for notifications
   * @param ignoreFilePath - Ignore file to update
   */
  const runIgnoreCommand = async (
    args: string,
    ctx: { ui: { notify: (message: string, level: "info" | "warning") => void } },
    ignoreFilePath: string,
  ): Promise<void> => {
    const pattern = parseIgnorePattern(args);
    if (!pattern) {
      ctx.ui.notify(
        `Usage: pass a file name or pattern, e.g. /local-agents-local-ignore ${DEFAULT_IGNORE_PATTERN}`,
        "warning",
      );
      return;
    }

    if (addIgnorePattern(ignoreFilePath, pattern)) {
      ctx.ui.notify(`Added "${pattern}" to ${ignoreFilePath}`, "info");
    } else {
      ctx.ui.notify(`"${pattern}" is already ignored by ${ignoreFilePath}`, "info");
    }
  };

  // Add a file name or pattern to the current repository's .gitignore.
  pi.registerCommand("local-agents-local-ignore", {
    description: `Add a file name or pattern to this repository's .gitignore (default: ${DEFAULT_IGNORE_PATTERN})`,
    handler: async (args, ctx) => {
      const repoRoot = findRepoRoot(ctx.cwd);
      if (!repoRoot) {
        ctx.ui.notify("Not inside a git repository", "warning");
        return;
      }
      await runIgnoreCommand(args, ctx, path.join(repoRoot, ".gitignore"));
    },
  });

  // Add a file name or pattern to the global Git exclude file.
  pi.registerCommand("local-agents-global-ignore", {
    description: `Add a file name or pattern to your global Git ignore file (default: ${DEFAULT_IGNORE_PATTERN})`,
    handler: async (args, ctx) => {
      await runIgnoreCommand(args, ctx, await resolveGlobalIgnoreFile(pi));
    },
  });
}
