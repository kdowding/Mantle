import type { Tool } from "../types.js";
import { resolve, relative, isAbsolute } from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";

// Serves the agent-manual corpus (docs/agent-manual/) on demand. MANTLE.md —
// the always-loaded baseline — points here; the agent passes a corpus path and
// gets that page back. Reads curated repo docs directly (NOT via the
// boundary-checked filesystem tools, so it works regardless of an agent's
// allowedRoots), but contains every read to the manual root so it can't be
// turned into a path-traversal primitive.
export function createMantleGuideTool(basePath: string): Tool {
  const manualRoot = resolve(basePath, "docs", "agent-manual");

  const within = (p: string): boolean => {
    const rel = relative(manualRoot, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };

  // Every servable page under the manual root. Skips `_`-prefixed dirs
  // (e.g. _proposed-templates/) — those are template drafts, not pages.
  const listDocs = (): string[] => {
    if (!existsSync(manualRoot)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith("_")) continue;
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".md")) {
          out.push("docs/agent-manual/" + relative(manualRoot, full).replace(/\\/g, "/"));
        }
      }
    };
    walk(manualRoot);
    return out.sort();
  };

  return {
    name: "mantle_guide",
    description: `Fetch a page of the MANTLE agent manual on demand — the detail behind any feature or workspace file. Pass a corpus path from MANTLE.md's table of contents (e.g. "docs/agent-manual/feature/voice.md"); omit \`doc\` to list every page. Read a page when the user asks how a feature works or how to shape one of their files, then help them with it.`,
    inputSchema: {
      type: "object",
      properties: {
        doc: {
          type: "string",
          description: "Corpus path of the page to fetch (e.g. docs/agent-manual/feature/voice.md). Omit to list all pages.",
        },
      },
      required: [],
    },
    async execute(input) {
      const docs = listDocs();
      const raw = typeof input.doc === "string" ? input.doc.trim() : "";

      if (!raw) {
        if (docs.length === 0) {
          return { content: "The MANTLE manual (docs/agent-manual/) isn't present in this install.", isError: true };
        }
        return {
          content: `# MANTLE manual — available pages\n\nFetch any with \`mantle_guide\` using its path:\n${docs.map((d) => `- ${d}`).join("\n")}`,
        };
      }

      // Accept "docs/agent-manual/x.md", a bare "feature/x.md", or a leading slash.
      const relPath = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^docs\/agent-manual\//, "");
      const target = resolve(manualRoot, relPath);

      if (!within(target)) {
        return { content: `"${raw}" is outside the manual. Use a path like docs/agent-manual/feature/voice.md.`, isError: true };
      }
      if (!target.endsWith(".md") || !existsSync(target)) {
        return {
          content: `No manual page at "${raw}".\n\nAvailable pages:\n${docs.map((d) => `- ${d}`).join("\n")}`,
          isError: true,
        };
      }
      try {
        return { content: readFileSync(target, "utf-8") };
      } catch (e) {
        return { content: `Failed to read "${raw}": ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  };
}
