import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { resolve, dirname, relative, join, isAbsolute, basename } from "path";
import type { Tool, ToolContext } from "../types.js";
import { checkReservedWindowsName, containmentError } from "./fs-boundary.js";
import { isPersonalityFile } from "../../agent/section-toggles.js";

export function createFilesystemTools(): Tool[] {
  return [readFile, writeFile, editFile, listDirectory, globFiles, grepFiles];
}

// Module-level singleton — set at boot from config.globalSkillsDir.
// Lets read_file resolve {global}/... aliases without threading the
// config through every ToolContext or every filesystem tool's call
// path. Stays null when mantle is run outside the normal boot path
// (tests, scripts) — alias resolution then falls back to leaving the
// alias literal, which the path-existence check will reject cleanly.
let _globalSkillsDir: string | null = null;
export function setGlobalSkillsDir(absolutePath: string): void {
  _globalSkillsDir = absolutePath;
}

// Resolve `{workspace}` and `{global}` aliases in a user-supplied
// path. The skill catalog renders paths like
// `{workspace}/skills/foo/SKILL.md` so the prompt stays stable across
// machines (no leaked $HOME, no cache-bust on dir rename) — this
// function reverses that to a real filesystem path when the model
// calls read_file with the aliased form.
//
//   {workspace}     → context.workspacePath  (agent's workspace root)
//   {workspace}/X   → <workspace>/X
//   {global}        → _globalSkillsDir       (shared skills root)
//   {global}/X      → <global>/X
//
// Unknown aliases pass through unchanged; the existsSync check in the
// caller surfaces a clear "file not found" error including the
// resolved path so the model can correct.
function resolveAliases(input: string, context?: ToolContext): string {
  if (input.startsWith("{workspace}")) {
    const ws = context?.workspacePath;
    if (!ws) return input; // No workspace context — let existsSync fail with a clear path
    return resolve(ws, input.slice("{workspace}".length).replace(/^[\\/]+/, ""));
  }
  if (input.startsWith("{global}")) {
    if (!_globalSkillsDir) return input;
    return resolve(_globalSkillsDir, input.slice("{global}".length).replace(/^[\\/]+/, ""));
  }
  return input;
}

// Resolve a user-supplied path against the calling agent's workspace.
// Aliases ({workspace}/..., {global}/...) resolve first, then absolute
// paths pass through unchanged, then relative paths resolve against
// context.workspacePath when available, else mantle's CWD (legacy
// behavior for tools invoked outside an agent loop — tests, boot-time
// registration).
function resolvePath(input: string, context?: ToolContext): string {
  const aliased = resolveAliases(input, context);
  if (isAbsolute(aliased)) return aliased;
  const base = context?.workspacePath ?? process.cwd();
  return resolve(base, aliased);
}

// In an autonomous (scheduled) run, refuse to overwrite the agent's own
// prompt-loaded identity files (AGENTS/SOUL/IDENTITY/USER/MEMORY/CALL at the
// workspace root) — they load into every prompt, so a write there is a
// persistent self-injection vector with no human to catch it. Chat is
// unaffected (the agent edits MEMORY.md etc. normally). Only the workspace's
// OWN top-level copies are protected, not a same-named file in a subdirectory.
function blockedIdentityWrite(context: ToolContext | undefined, resolvedPath: string): boolean {
  if (!context?.autonomous || !context.workspacePath) return false;
  const name = basename(resolvedPath);
  return isPersonalityFile(name) && resolve(context.workspacePath, name) === resolvedPath;
}

// The Windows reserved-name guard and path containment now live in
// ./fs-boundary.ts (shared with attach_local_file).

// Directory basenames pruned during recursive glob/grep walks. These are
// dependency / build / VCS-cache trees that hold tens of thousands of files an
// agent almost never wants to match BY NAME — descending into them is exactly
// what turned a `glob **/MANTLE.md` into a multi-minute, event-loop-starving
// scan (.venv alone is 60k+ files in this repo). The basePath root is never
// matched against this set (only its descendants are), so scoping `path` INTO
// an ignored dir still searches it — only nested occurrences are pruned.
// Overridable at boot via config.tools.filesystem.ignoreDirs (set [] to walk
// everything). Lives here, not in DEFAULT_CONFIG, because walkFiles owns its
// own traversal contract and tests exercise it with no config loaded.
const DEFAULT_IGNORE_DIRS = [
  "node_modules", ".git", ".svn", ".hg",
  ".venv", ".venv-streaming", "venv", "__pycache__",
  ".mypy_cache", ".pytest_cache", ".ruff_cache",
  "dist", "build", ".next", ".nuxt", ".turbo", ".cache",
  "target", ".gradle", ".idea",
];
let _ignoreDirs = new Set(DEFAULT_IGNORE_DIRS);
export function setWalkIgnoreDirs(dirs: string[]): void {
  _ignoreDirs = new Set(dirs);
}

// Resilient directory walker. Yields absolute paths of all regular files
// under `basePath`, skipping entries that error out on readdir/stat — which
// happens for Windows reserved names (`nul`, `con`, etc.), broken symlinks,
// and files with permission issues. Unlike Bun.Glob's built-in scan, a
// single bad entry doesn't kill the whole traversal.
//
// Symlinks are NOT followed (avoids infinite loops; matches ripgrep default).
// Dependency/build/VCS dirs (DEFAULT_IGNORE_DIRS) are pruned by name.
// Caller applies glob-pattern matching via Bun.Glob.match() on each yield.
//
// Signal handling: `signal.throwIfAborted()` is called at the top of each
// directory pop AND every 64 entries within a directory, so /stop mid-walk
// surfaces an AbortError to the consumer (grep/glob) within a few ms on
// realistic trees. Without this, a `/stop` during `grep_files` on a giant
// repo had to wait for the walk to complete naturally before the loop's
// post-tool signal check could fire — a multi-second user-visible tail.
//
// Event-loop cooperation: readdirSync is synchronous and this generator has
// no other await, so a large walk would otherwise run as one unbroken
// microtask chain that STARVES Bun's single-threaded event loop — incoming
// HTTP/WS (even a page refresh) can't be serviced until the walk completes.
// Every ~512 entries we hand a macrotask back via setImmediate, bounding that
// window to a few ms. (The ignore-list keeps real walks small; this guards
// the rare deliberately-huge one — e.g. a base path scoped into node_modules.)
async function* walkFiles(basePath: string, signal?: AbortSignal): AsyncGenerator<string> {
  const stack: string[] = [basePath];
  let entriesSinceCheck = 0;
  let blocksSinceYield = 0;
  while (stack.length > 0) {
    signal?.throwIfAborted();
    const current = stack.pop()!;
    let entries: import("fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip and keep walking
    }
    for (const entry of entries) {
      // Periodic abort check + event-loop yield inside very wide
      // directories — every 64 entries. Wider than typical (most dirs are
      // tiny) but tight enough that a giant folder doesn't ignore /stop for
      // seconds. Counter is shared across dirs so a flood of small dirs
      // still checks regularly. Every 8th check (~512 entries) also yields a
      // macrotask so the event loop can service I/O mid-walk.
      if (++entriesSinceCheck >= 64) {
        entriesSinceCheck = 0;
        signal?.throwIfAborted();
        if (++blocksSinceYield >= 8) {
          blocksSinceYield = 0;
          await new Promise<void>((r) => setImmediate(r));
        }
      }
      const full = join(current, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (_ignoreDirs.has(entry.name)) continue; // prune deps/build/VCS
          stack.push(full);
        } else if (entry.isFile()) {
          yield full;
        }
      } catch {
        // Dirent accessor threw — skip this entry
      }
    }
  }
}

// Detect a thrown abort. signal.throwIfAborted() throws DOMException
// (name="AbortError") in standard environments and Bun matches that. Use
// the name check because instanceof DOMException isn't reliable across
// node/bun/jsdom mixes.
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

// Normalize a path to forward slashes for glob pattern matching (POSIX-style
// patterns don't match Windows backslashes).
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

const readFile: Tool = {
  name: "read_file",
  description: [
    "Read the contents of a file with line numbers in `N\\t<line>` format. Defaults to the first 2000 lines; pass `offset` (1-based start line) and `limit` to read a specific slice of a large file.",
    "Relative paths resolve against your agent workspace root — `read_file('MEMORY.md')` reads `<workspace>/MEMORY.md` directly. Absolute paths pass through unchanged.",
    "If you don't know the exact path, run `list_directory` or `glob_files` first instead of guessing. Always read a file before editing it — `edit_file` requires exact text match including whitespace.",
    "Examples: `read_file('AGENTS.md')`, `read_file('src/server/ws.ts', offset: 100, limit: 50)`.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read (relative to agent workspace, or absolute)" },
      offset: { type: "number", description: "Line number to start reading from (1-based)" },
      limit: { type: "number", description: "Maximum number of lines to read" },
    },
    required: ["path"],
  },
  async execute(input, context) {
    const given = String(input.path);
    const reserved = checkReservedWindowsName(given);
    if (reserved) return { content: reserved, isError: true };
    const path = resolvePath(given, context);
    const contained = containmentError(path, given);
    if (contained) return { content: contained, isError: true };
    const offset = Number(input.offset ?? 1);
    const limit = Number(input.limit ?? 2000);

    if (!existsSync(path)) {
      return { content: `File not found: ${given} (resolved to ${path})`, isError: true };
    }

    try {
      const raw = readFileSync(path, "utf-8");
      const lines = raw.split("\n");
      const start = Math.max(0, offset - 1);
      const end = Math.min(lines.length, start + limit);
      const slice = lines.slice(start, end);

      const numbered = slice
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join("\n");

      const header = `File: ${given} (${lines.length} lines total, showing ${start + 1}-${end})`;
      return { content: `${header}\n\n${numbered}` };
    } catch (err) {
      return { content: `Error reading file: ${err}`, isError: true };
    }
  },
};

const writeFile: Tool = {
  name: "write_file",
  description: [
    "Write content to a file. Creates parent directories if needed. **Overwrites existing files entirely** — no diff, no merge.",
    "Prefer `edit_file` for surgical changes to existing files; reach for `write_file` only for new files, full rewrites, or pre-assembled content (e.g. a generated config or a fresh document). Path resolves against your agent workspace, same as `read_file`.",
    "Returns a confirmation with the line count written. Use absolute paths to write outside the workspace.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write to" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  async execute(input, context) {
    const given = String(input.path);
    const reserved = checkReservedWindowsName(given);
    if (reserved) return { content: reserved, isError: true };
    const path = resolvePath(given, context);
    const contained = containmentError(path, given);
    if (contained) return { content: contained, isError: true };
    if (blockedIdentityWrite(context, path)) {
      return { content: `Writing ${basename(path)} is blocked in an autonomous run — identity/persona files load into every prompt, so a scheduled job can't self-edit them. Make changes from a chat session instead.`, isError: true };
    }
    const content = String(input.content);

    try {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(path, content, "utf-8");
      const lines = content.split("\n").length;
      return { content: `Written ${lines} lines to ${given}` };
    } catch (err) {
      return { content: `Error writing file: ${err}`, isError: true };
    }
  },
};

const editFile: Tool = {
  name: "edit_file",
  description: [
    "Replace a specific string in a file with a new string. The match must be exact AND unique — `old_string` must appear exactly once, with all whitespace (tabs, spaces, newlines) byte-identical to the file.",
    "**Always `read_file` first** and copy the text directly from its output — don't reconstruct from memory. Indentation in particular is unforgiving: a tab where the file has spaces makes the match fail.",
    "If the call returns 'whitespace-normalized near-match exists', the file's whitespace differs from what you sent — re-read with `read_file` and copy the exact characters, don't just retry.",
    "If the call returns 'found N times', `old_string` isn't unique — widen the context with surrounding lines until exactly one match exists.",
    "For renaming a symbol across many lines, run multiple `edit_file` calls in parallel, or use `write_file` with the full new content. For a brand-new file, use `write_file` directly.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to edit" },
      old_string: { type: "string", description: "The exact text to find and replace" },
      new_string: { type: "string", description: "The replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input, context) {
    const given = String(input.path);
    const reserved = checkReservedWindowsName(given);
    if (reserved) return { content: reserved, isError: true };
    const path = resolvePath(given, context);
    const contained = containmentError(path, given);
    if (contained) return { content: contained, isError: true };
    if (blockedIdentityWrite(context, path)) {
      return { content: `Editing ${basename(path)} is blocked in an autonomous run — identity/persona files load into every prompt, so a scheduled job can't self-edit them. Make changes from a chat session instead.`, isError: true };
    }
    const oldStr = String(input.old_string);
    const newStr = String(input.new_string);

    if (!existsSync(path)) {
      return { content: `File not found: ${given} (resolved to ${path})`, isError: true };
    }

    try {
      const content = readFileSync(path, "utf-8");
      const count = content.split(oldStr).length - 1;

      if (count === 0) {
        // Check for whitespace-normalized near-match to give a more actionable
        // error. LLMs frequently hallucinate tabs/spaces; if the content shows
        // up after collapsing whitespace, tell the caller to re-read the file
        // instead of retrying with the same bad whitespace.
        const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
        const contentNorm = normalize(content);
        const oldNorm = normalize(oldStr);
        if (oldNorm.length > 0 && contentNorm.includes(oldNorm)) {
          return {
            content: `old_string not found in ${given}, but a whitespace-normalized near-match exists. The file's indentation (tabs vs spaces, line breaks) likely differs from what you provided. Re-read the file with read_file and copy the exact characters — don't reconstruct from memory.`,
            isError: true,
          };
        }
        return { content: `old_string not found in ${given}. Re-read the file with read_file to get the exact text; make sure surrounding whitespace matches.`, isError: true };
      }
      if (count > 1) {
        return { content: `old_string found ${count} times in ${given}. Must be unique. Provide more context.`, isError: true };
      }

      const updated = content.replace(oldStr, newStr);
      writeFileSync(path, updated, "utf-8");
      return { content: `Edited ${given}: replaced 1 occurrence` };
    } catch (err) {
      return { content: `Error editing file: ${err}`, isError: true };
    }
  },
};

const listDirectory: Tool = {
  name: "list_directory",
  description: [
    "List the contents of a directory with file types (`dir`/`file`) and human-readable sizes. Single-level only — does not recurse. Path resolves against your agent workspace.",
    "Use this to orient yourself when you don't know what's in a directory; reach for `glob_files` instead when you have a known pattern (`**/*.ts`, etc.) and want files by name across nested directories.",
    "Examples: `list_directory('.')` for the workspace root, `list_directory('src/agent')` for a subdirectory.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path to list" },
    },
    required: ["path"],
  },
  async execute(input, context) {
    const given = String(input.path);
    const reserved = checkReservedWindowsName(given);
    if (reserved) return { content: reserved, isError: true };
    const path = resolvePath(given, context);
    const contained = containmentError(path, given);
    if (contained) return { content: contained, isError: true };

    if (!existsSync(path)) {
      return { content: `Directory not found: ${given}`, isError: true };
    }

    try {
      const entries = readdirSync(path, { withFileTypes: true });
      const lines = entries.map((e) => {
        const type = e.isDirectory() ? "dir " : "file";
        let size = "";
        if (!e.isDirectory()) {
          try {
            const stat = statSync(join(path, e.name));
            size = ` (${formatSize(stat.size)})`;
          } catch {
            // Skip size
          }
        }
        return `${type}  ${e.name}${size}`;
      });

      return { content: `Directory: ${given}\n\n${lines.join("\n")}` };
    } catch (err) {
      return { content: `Error listing directory: ${err}`, isError: true };
    }
  },
};

const globFiles: Tool = {
  name: "glob_files",
  description: [
    "Find files BY NAME matching a glob pattern. Recursive by default. Returns absolute paths, capped at 500 matches.",
    "Pattern syntax: `**` matches any directories, `*` matches anything within a single segment, `{a,b}` is alternation. Examples: `**/*.ts` (all TS files), `src/**/*.{ts,tsx}` (TS/TSX under src), `**/AGENTS.md`, `*.json` (JSON in cwd only).",
    "Pass `path` to scope to a subdirectory; defaults to your agent workspace. Dependency/build/VCS dirs (node_modules, .git, .venv, dist, __pycache__, …) are skipped — to search inside one, point `path` directly at it.",
    "Use this for finding files by name; use `grep_files` to search file *contents*. Don't substitute one for the other — they look different.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match" },
      path: { type: "string", description: "Base directory to search in" },
    },
    required: ["pattern"],
  },
  async execute(input, context) {
    const pattern = String(input.pattern);
    const givenPath = String(input.path ?? ".");
    const reserved = checkReservedWindowsName(givenPath);
    if (reserved) return { content: reserved, isError: true };
    const basePath = resolvePath(givenPath, context);
    const contained = containmentError(basePath, givenPath);
    if (contained) return { content: contained, isError: true };

    const matches: string[] = [];
    try {
      const glob = new Bun.Glob(pattern);
      for await (const filePath of walkFiles(basePath, context?.signal)) {
        const rel = toPosix(relative(basePath, filePath));
        if (!glob.match(rel)) continue;
        matches.push(filePath);
        if (matches.length >= 500) break; // Safety limit
      }

      if (matches.length === 0) {
        return { content: `No files matching pattern: ${pattern}` };
      }

      return { content: `Found ${matches.length} files:\n\n${matches.join("\n")}` };
    } catch (err) {
      // /stop fired mid-walk — surface a partial-result message rather
      // than a generic error. The loop's own signal check will exit on
      // the next iteration; this just keeps the tool_result coherent.
      if (isAbortError(err)) {
        return { content: `glob_files aborted — scanned partial tree, ${matches.length} match(es) collected before /stop`, isError: true };
      }
      return { content: `Error globbing: ${err}`, isError: true };
    }
  },
};

const grepFiles: Tool = {
  name: "grep_files",
  description: [
    "Search file CONTENTS for a regex pattern. Returns matching lines as `<path>:<lineno>: <line>`, capped at 200 matches.",
    "Pattern is a JavaScript regex, applied case-insensitively. Escape regex metachars with `\\\\` — `\\\\.` for a literal dot, `\\\\b` for word boundary, `\\\\(` for paren. Plain words work without escaping.",
    "Pass `glob` to filter which files are searched (`glob: '*.ts'`, `glob: 'src/**/*.py'`). Without it, all files under `path` (or the workspace root) are searched. Files larger than 1MB are skipped, as are dependency/build/VCS dirs (node_modules, .git, .venv, dist, …) — point `path` at one to search inside it.",
    "Use this to find references, definitions, or usage of a symbol; use `glob_files` if you want to find files by NAME instead.",
    "Examples: `grep_files('TODO', glob: '*.ts')`, `grep_files('export\\\\s+function\\\\s+buildSystemPrompt')`.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Directory to search in" },
      glob: { type: "string", description: "Glob pattern to filter files (e.g., '*.ts')" },
    },
    required: ["pattern"],
  },
  async execute(input, context) {
    const pattern = String(input.pattern);
    const givenPath = String(input.path ?? ".");
    const reserved = checkReservedWindowsName(givenPath);
    if (reserved) return { content: reserved, isError: true };
    const basePath = resolvePath(givenPath, context);
    const contained = containmentError(basePath, givenPath);
    if (contained) return { content: contained, isError: true };
    const fileGlob = String(input.glob ?? "**/*");

    const matches: string[] = [];
    const signal = context?.signal;
    try {
      const regex = new RegExp(pattern, "gi");
      const glob = new Bun.Glob(fileGlob);

      // walkFiles checks signal at each dir + every 64 entries; we
      // additionally check between files here so a single huge file
      // doesn't ignore /stop while we're reading its contents.
      for await (const filePath of walkFiles(basePath, signal)) {
        signal?.throwIfAborted();
        if (matches.length >= 200) break;
        const rel = toPosix(relative(basePath, filePath));
        if (!glob.match(rel)) continue;
        try {
          const stat = statSync(filePath);
          if (stat.size > 1_000_000) continue; // Skip large files

          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push(`${filePath}:${i + 1}: ${lines[i].trim()}`);
              regex.lastIndex = 0; // Reset for global regex
            }
            if (matches.length >= 200) break;
          }
        } catch {
          // Skip unreadable files (binary, permission denied, etc.)
        }
      }

      if (matches.length === 0) {
        return { content: `No matches for pattern: ${pattern}` };
      }

      return { content: `Found ${matches.length} matches:\n\n${matches.join("\n")}` };
    } catch (err) {
      if (isAbortError(err)) {
        return { content: `grep_files aborted — ${matches.length} match(es) collected before /stop`, isError: true };
      }
      return { content: `Error searching: ${err}`, isError: true };
    }
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
