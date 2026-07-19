// Human-readable one-line label for a tool call, shown next to the live "Ns"
// counter while the tool runs. bash already streams progress, but englyph /
// MCP / web tools emit nothing until they return — so without a label they
// read as "stuck." "recall: \"flaky tests\"" or "web_fetch x.ai" tells the
// user what's happening at a glance.
//
// Pure + defensive: runs inside the hot Promise.all tool-dispatch map on
// UNVALIDATED model output, so every field access is typeof-guarded and it
// never throws. Returns undefined only when the args couldn't be parsed
// (so the UI falls back to the bare spinner) — never renders raw _parseError.

export const LABEL_ARG_MAX = 40;

function truncArg(v: unknown): string {
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > LABEL_ARG_MAX ? s.slice(0, LABEL_ARG_MAX) + "…" : s;
}

// Last path segment, handling both / and \ (Windows workspace paths).
function basename(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

// First string-valued field, for unknown tools — better than a blank label.
function firstStringField(input: Record<string, unknown>): string | undefined {
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export function toolLabel(name: string, input: Record<string, unknown>): string | undefined {
  // Unrepairable args — no meaningful label; let the UI show a bare spinner.
  if ((input as { _parseError?: unknown })._parseError === true) return undefined;

  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file": {
      const p = str(input, "path");
      const verb = name === "read_file" ? "read" : name === "write_file" ? "write" : "edit";
      return p ? `${verb} ${basename(p)}` : verb;
    }
    case "list_directory": {
      const p = str(input, "path");
      return p ? `list ${basename(p)}` : "list_directory";
    }
    case "glob_files": {
      const p = str(input, "pattern");
      return p ? `glob ${truncArg(p)}` : "glob_files";
    }
    case "grep_files": {
      const p = str(input, "pattern");
      return p ? `grep "${truncArg(p)}"` : "grep_files";
    }
    case "recall":
    case "recall_source": {
      const q = str(input, "query") ?? str(input, "q");
      return q ? `recall: "${truncArg(q)}"` : name;
    }
    case "remember":
      return "remember";
    case "web_fetch": {
      const url = str(input, "url");
      if (!url) return "web_fetch";
      try {
        return `web_fetch ${new URL(url).hostname}`;
      } catch {
        return `web_fetch ${truncArg(url)}`;
      }
    }
    case "bash": {
      const cmd = str(input, "command");
      return cmd ? `bash: ${truncArg(cmd)}` : "bash";
    }
    case "attach_local_file":
    case "attach_url_file": {
      const target = str(input, "path") ?? str(input, "url");
      return target ? `attach ${basename(target)}` : name;
    }
    case "spawn_agent":
      return "spawn_agent";
    default: {
      if (name.startsWith("englyph_")) {
        const q = str(input, "query") ?? str(input, "q") ?? str(input, "text");
        return q ? `${name}: "${truncArg(q)}"` : name;
      }
      const first = firstStringField(input);
      return first ? `${name}: "${truncArg(first)}"` : name;
    }
  }
}
