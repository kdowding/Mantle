// Architecture guard — enforces the layering rules the room contract
// (src/rooms/types.ts) depends on. Run via `bun run check:arch`; part of
// the verification loop next to typecheck + lint.
//
// Assertions:
//   (a) CORE never imports rooms, integrations, or the server: nothing under
//       src/agent/, src/tools/, src/cron/ imports from src/rooms/,
//       src/integrations/, or src/server/ (those upper layers are wired at the
//       composition root, src/index.ts).
//   (b) ROOMS and INTEGRATIONS never import the server: nothing under
//       src/rooms/ or src/integrations/ imports from src/server/ (server
//       capabilities like broadcast are injected at construction).
//   (c) No multi-file cycle held together by a VALUE edge — type-only
//       cycles are tolerated (erased at runtime) but reported; a value
//       cycle is a real init-order hazard.
//   (d) Every relative import resolves to a real file.
//
// Detection is regex-based (static import/export-from/dynamic import) —
// good enough for this codebase's plain ESM style; tsc catches anything
// exotic.

import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join, resolve, dirname, relative, sep } from "path";

const SRC = resolve(import.meta.dir, "..", "src");

interface Edge {
  from: string; // repo-relative posix path
  to: string;
  typeOnly: boolean;
  raw: string;
  line: number;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) yield full;
  }
}

const toPosix = (p: string): string => p.split(sep).join("/");
const rel = (abs: string): string => toPosix(relative(resolve(SRC, ".."), abs));

// Resolve a relative specifier from `fromFile` to an actual .ts file.
// Mantle's convention is `./x.js` for `./x.ts`; also tolerate
// extensionless + index resolution defensively.
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.endsWith(".ts") ? base : `${base}.ts`,
    join(base, "index.ts"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// Pull every import-ish statement out of a source file. Comments are
// stripped first so commented-out imports don't count.
function parseEdges(file: string): { edges: Edge[]; unresolved: Edge[] } {
  const srcRaw = readFileSync(file, "utf-8");
  const src = srcRaw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, pre) => pre + " ".repeat(m.length - pre.length));

  const edges: Edge[] = [];
  const unresolved: Edge[] = [];
  const patterns: Array<{ re: RegExp; typeOnlyGroup?: (m: RegExpExecArray) => boolean }> = [
    // import ... from "x" / import "x"
    {
      re: /import\s+(type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?["']([^"']+)["']/g,
      typeOnlyGroup: (m) => !!m[1],
    },
    // export ... from "x"
    {
      re: /export\s+(type\s+)?(?:\*|\{[^}]*\})\s*from\s+["']([^"']+)["']/g,
      typeOnlyGroup: (m) => !!m[1],
    },
    // dynamic import("x") — always a value edge
    { re: /import\(\s*["']([^"']+)["']\s*\)/g },
  ];

  for (const { re, typeOnlyGroup } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const spec = m[m.length - 1]!;
      if (!spec.startsWith(".")) continue; // packages aren't graph edges
      const line = src.slice(0, m.index).split("\n").length;
      const typeOnly = typeOnlyGroup ? typeOnlyGroup(m) : false;
      const target = resolveSpecifier(file, spec);
      const edge: Edge = {
        from: rel(file),
        to: target ? rel(target) : spec,
        typeOnly,
        raw: spec,
        line,
      };
      if (target) edges.push(edge);
      else unresolved.push(edge);
    }
  }
  return { edges, unresolved };
}

// ── Build the graph ─────────────────────────────────────────────────────────

const files = [...walk(SRC)];
const allEdges: Edge[] = [];
const allUnresolved: Edge[] = [];
for (const f of files) {
  const { edges, unresolved } = parseEdges(f);
  allEdges.push(...edges);
  allUnresolved.push(...unresolved);
}

const failures: string[] = [];
const warnings: string[] = [];

// (d) unresolved relative imports
for (const e of allUnresolved) {
  failures.push(`unresolved import: ${e.from}:${e.line} → "${e.raw}"`);
}

// (a) core → rooms/server
const CORE_PREFIXES = ["src/agent/", "src/tools/", "src/cron/"];
const UPPER_LAYERS = ["src/rooms/", "src/integrations/", "src/server/"];
for (const e of allEdges) {
  const fromCore = CORE_PREFIXES.some((p) => e.from.startsWith(p));
  if (fromCore && UPPER_LAYERS.some((p) => e.to.startsWith(p))) {
    const layer = e.to.startsWith("src/rooms/")
      ? "a room"
      : e.to.startsWith("src/integrations/")
        ? "an integration"
        : "the server";
    failures.push(
      `core imports ${layer}: ${e.from}:${e.line} → ${e.to}${e.typeOnly ? " (type-only — still forbidden: keep core ignorant of upper layers)" : ""}`,
    );
  }
}

// (b) rooms → server
for (const e of allEdges) {
  if (e.from.startsWith("src/rooms/") && e.to.startsWith("src/server/")) {
    failures.push(
      `room imports the server (capabilities must be injected): ${e.from}:${e.line} → ${e.to}`,
    );
  }
}

// (b2) integrations → server — same rule as rooms; the server composes
// per-agent tool visibility and owns the generic REST surface, so an
// integration must not reach into it (caps are injected at construction).
for (const e of allEdges) {
  if (e.from.startsWith("src/integrations/") && e.to.startsWith("src/server/")) {
    failures.push(
      `integration imports the server (capabilities must be injected): ${e.from}:${e.line} → ${e.to}`,
    );
  }
}

// (c) SCCs with a value edge — Tarjan over the value+type graph, then check
// each multi-node component for any non-type edge.
{
  const nodes = [...new Set([...allEdges.map((e) => e.from), ...allEdges.map((e) => e.to)])];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  const out = new Map<string, Edge[]>();
  for (const e of allEdges) {
    const list = out.get(e.from) ?? [];
    list.push(e);
    out.set(e.from, list);
  }

  // Iterative Tarjan (recursion depth could exceed the stack on a big tree).
  function strongConnect(start: string): void {
    interface Frame { node: string; edgeIdx: number }
    const frames: Frame[] = [{ node: start, edgeIdx: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const edges = out.get(frame.node) ?? [];
      if (frame.edgeIdx < edges.length) {
        const next = edges[frame.edgeIdx]!.to;
        frame.edgeIdx++;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter++;
          stack.push(next);
          onStack.add(next);
          frames.push({ node: next, edgeIdx: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
        }
      } else {
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) {
          low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        }
        if (low.get(frame.node) === index.get(frame.node)) {
          const scc: string[] = [];
          for (;;) {
            const n = stack.pop()!;
            onStack.delete(n);
            scc.push(n);
            if (n === frame.node) break;
          }
          if (scc.length > 1) sccs.push(scc);
        }
      }
    }
  }
  for (const n of nodes) if (!index.has(n)) strongConnect(n);

  for (const scc of sccs) {
    const inScc = new Set(scc);
    const valueEdges = allEdges.filter((e) => inScc.has(e.from) && inScc.has(e.to) && !e.typeOnly);
    const label = scc.length <= 6 ? scc.join(" ↔ ") : `${scc.slice(0, 6).join(" ↔ ")} … (${scc.length} files)`;
    if (valueEdges.length > 0) {
      failures.push(
        `value-edge cycle (${scc.length} files): ${label}\n    value edges: ${valueEdges.map((e) => `${e.from}:${e.line}→${e.to}`).join(", ")}`,
      );
    } else {
      warnings.push(`type-only cycle (${scc.length} files, runtime-safe but fragile): ${label}`);
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`[check-arch] ${files.length} files, ${allEdges.length} edges`);
for (const w of warnings) console.log(`  warn: ${w}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  console.error(`[check-arch] ${failures.length} violation(s)`);
  process.exit(1);
}
console.log("[check-arch] OK — no direction violations, no value-edge cycles, all imports resolve");
