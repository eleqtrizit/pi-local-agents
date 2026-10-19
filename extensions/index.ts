/**
 * pi-local-agents — extension package entry point.
 *
 * Registers the local-agents extension: loads every project-local *_AGENTS.md
 * file, injects their contents into the agent context (system prompt, re-read
 * each turn), and renders a boot notice as a custom session entry. Git ignore
 * rules are opt-in via two slash commands: /local-agents-local-ignore (repo
 * .gitignore) and /local-agents-global-ignore (global Git exclude file). See
 * ./local-agents.ts for the implementation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import localAgentsExtension from "./local-agents.js";

export default function (pi: ExtensionAPI) {
  localAgentsExtension(pi);
}
