/**
 * pi-local-agents — extension package entry point.
 *
 * Registers the local-agents extension: loads every project-local *_AGENTS.md
 * file, injects their contents into the agent context (system prompt, re-read
 * each turn), renders a boot notice as a custom session entry, and keeps the
 * files out of version control via .gitignore backfill. See ./local-agents.ts
 * for the implementation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import localAgentsExtension from "./local-agents.js";

export default function (pi: ExtensionAPI) {
  localAgentsExtension(pi);
}
