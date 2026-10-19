# pi-local-agents

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that loads every project-local `*_AGENTS.md` file (e.g. `LOCAL_AGENTS.md`, `TEAM_AGENTS.md`) into the agent context and shows a boot notice at startup.

## Quick Start

Install:

```
pi install https://github.com/eleqtrizit/pi-local-agents
```

Create any `*_AGENTS.md` file in your project root:

```bash
echo "Keep answers terse." > LOCAL_AGENTS.md
```

Start (or `/reload`) pi in that project:

- Every `*_AGENTS.md` file's content is injected into the system prompt on each turn — edits apply without reloading.
- A boot notice in the transcript lists each loaded file with its line count.
- The files are kept out of version control (the extension backfills `*_AGENTS.md` into `.gitignore`).

## Private Local Notes

One benefit of using this extension: you can load your own private local notes on how to do things — things that might be specific to you, e.g. permissions, level of access, machine quirks — without having them show up in the git repo.

## Git Ignore

Two ways to keep your `*_AGENTS.md` notes out of version control:

### Option 1: Global ignore (across all repositories)

If you want Git to ignore these files across **every project** on your computer, set up a global exclude file — no repository `.gitignore` gets touched at all, which is handy in shared/team repos where you don't want to commit even the ignore rule.

- **Create your global ignore file.** By default, Git looks for this at `~/.config/git/ignore`, but you can put one in your user home directory:

  ```bash
  touch ~/.gitignore_global
  ```

- **Tell Git to use it globally:**

  ```bash
  git config --global core.excludesfile ~/.gitignore_global
  ```

- **Add the notes rule to that file.** Open `~/.gitignore_global` in a text editor and add the pattern:

  ```text
  # Ignore all personal local agent notes everywhere
  *_AGENTS.md
  ```

### Option 2: Per-repo `.gitignore` (automatic)

The extension does this for you — that's the whole point. Whenever a `*_AGENTS.md` file exists (or is just created/edited via a tool), the extension backfills the `*_AGENTS.md` pattern into that repository's `.gitignore`. You only need Option 1 if you don't want the rule written to the repo's `.gitignore` at all.

## Getting Started

Point your pi agent at this repo and ask:

> How do I get started?

The agent reads `AGENTS.md` in this repo and will walk you through the setup: copying the template to a new directory, installing dependencies, and running the example extension.

## What's Included

```
extensions/index.ts   Example extension: hello_world and echo tools, tool_call gate, /template command
src/                  Source modules the extension imports
tests/                Vitest tests (mirrors src/)
package.json          pi-package metadata (main, pi.extensions)
tsconfig.json         Strict TypeScript (ESNext, NodeNext); typecheck only, no build step
```

## Manual Steps (for reference)

1. Copy the template to a new directory (Linux/macOS, skipping `.git` and `node_modules`):

   ```bash
   rsync -vrt --delete --delete-excluded --exclude node_modules --exclude .git ./ /path/to/new-repo/
   ```

2. `npm install` (or initialize from scratch: `npm init -y`, then `npm install --save-dev typescript vitest @types/node @earendil-works/pi-coding-agent && npm install typebox`).
3. Keep `tsconfig.json` as-is (ESNext, NodeNext, strict). No build step needed; pi loads TypeScript via jiti. Use `npx tsc --noEmit` for typechecking.
4. Check `package.json`: `main` and `pi.extensions` point at the entry point (`extensions/index.ts`), `keywords: ["pi-package"]`, `typebox` in `dependencies`, `@earendil-works/pi-coding-agent` as a peer.
5. Edit `extensions/index.ts` (or replace it). The default export is a factory receiving `ExtensionAPI`.
6. Test:

   ```bash
   npm run typecheck
   pi -e ./extensions/index.ts     # quick manual test
   npm test                        # vitest
   ```

   For auto-discovery and `/reload`, place extensions in `~/.pi/agent/extensions/` or project `.pi/extensions/`.
7. Publish: update the version, then `npm publish`. Users install with `pi install npm:<name>`. Runtime deps must go in `dependencies` (pi installs with `--omit=dev`).

Package names: `@earendil-works/pi-coding-agent` and `typebox` are current; `@mariozechner/pi-coding-agent` and `@sinclair/typebox` are obsolete.

## Key APIs

```ts
pi.registerTool()      // custom tools the LLM can call
pi.on(event, handler)  // session_start, session_shutdown, before_agent_start,
                       // tool_call, tool_result, turn_start/turn_end, ...
pi.registerCommand("name", {...})
```

Every handler receives an `ExtensionContext` with `ctx.ui` (notify, setStatus, setWidget, select, confirm, input, editor), `ctx.sessionManager`, `ctx.cwd`, `ctx.mode`, and more.

## Documentation

After `npm install`, docs and examples ship inside the pi package:

- Docs: `node_modules/@earendil-works/pi-coding-agent/docs/` (start with `extensions.md` and `writing-an-extension.md`)
- Examples: `node_modules/@earendil-works/pi-coding-agent/examples/extensions/`
