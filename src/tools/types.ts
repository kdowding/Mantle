// Metadata for a file an agent has attached to its turn (via
// attach_local_file / attach_url_file). Same fields the user-upload
// pipeline produces — the file lives in uploads/<agent>/<session>/
// and is served by the existing /api/uploads/... endpoint, so the UI
// can render it with the same renderer used for user attachments.
export interface AgentAttachmentMeta {
  fileId: string;
  filename: string;
  mediaType: string;
  size: number;
  category: "image" | "text" | "pdf" | "audio" | "video" | "binary";
  caption?: string;
  extractedText?: string;
}

// Semantic outcome of a tool call, a superset of the legacy isError
// boolean: "ok" succeeded, "failed" ran-but-errored (or threw), "empty"
// succeeded but produced nothing useful (0 results / no output). Stamped
// by ToolRegistry.execute via classifyToolResult — tools themselves only
// set content/isError/attachments. INVARIANT: isError === true ⟹ status
// === "failed" (status never disagrees with the legacy flag).
export type ToolStatus = "ok" | "failed" | "empty";

export interface ToolResult {
  content: string;
  isError?: boolean;
  // Files the tool produced and wants delivered to the user as an
  // attachment in the assistant turn. The agent loop forwards these
  // to the WS layer (live event) and prepends them as content blocks
  // on the next assistant message (persistence).
  attachments?: AgentAttachmentMeta[];
  // Populated by ToolRegistry.execute (NOT by tools). Transient — used by
  // the loop-detector (failing-tool signal) and the UI chip; never
  // persisted to the JSONL tool_result content block.
  status?: ToolStatus;
  tag?: string;
}

// A chunk of live output from a long-running tool. Emitted via
// ToolContext.progress so the UI can render output as it lands instead
// of waiting for the full result. `stream` distinguishes stdout vs
// stderr for shell-style tools; for everything else it's omitted.
export interface ToolProgressEvent {
  chunk: string;
  stream?: "stdout" | "stderr";
}

// Per-call context threaded from the caller (agent loop invocation) down to
// the tool. Lets tools that need awareness of the calling session (e.g.
// background task enqueue, session-scoped side effects) pick it up without
// each caller having to wire a closure. Optional — most tools ignore it.
export interface ToolContext {
  agentId: string;
  sessionId: string;
  // Absolute path to the calling agent's workspace. Filesystem tools resolve
  // relative paths against this — so when the agent (guided by AGENTS.md)
  // says `read_file("MEMORY.md")` it lands at
  // <workspacePath>/MEMORY.md, not mantle's CWD. Absolute paths passed by
  // the agent bypass this resolution.
  workspacePath?: string;
  // Populated by src/index.ts at startup. Tools that enqueue async work
  // (englyph_research_async, etc.) grab this via the context instead of
  // requiring a module-level singleton.
  backgroundRunner?: {
    start(params: {
      toolName: string;
      toolArgs: Record<string, unknown>;
      sessionId: string;
      agentId: string;
      summary?: string;
    }): Promise<{ taskId: string }>;
  };
  // Sub-agent spawn manager. Populated only for chat sessions (and
  // sub-agent sessions below the depth cap) — cron tasks
  // run with a null subagentManager so they can't spawn. The
  // spawn_agent tool reads this from context and errors clearly when
  // it's missing. Structural typing so tools don't import the manager
  // class directly (avoids circular deps).
  subagentManager?: {
    start(params: {
      parentSessionId: string;
      parentAgentId: string;
      parentDepth: number;
      task: string;
      toolWhitelist?: string[];
      model?: string;
    }): Promise<{ taskId: string; childSessionId: string }>;
  };
  // How deep the calling session is in a sub-agent chain. 0 for a normal
  // top-level chat session; 1 inside a child; 2 inside a grandchild.
  // spawn_agent checks this against MAX_SUBAGENT_DEPTH and refuses to
  // spawn at the cap. Defaults to 0 when omitted, so a missing
  // depth read like "is top-level" — safe default.
  subagentDepth?: number;
  // Parent session id when running inside a sub-agent. Lets sub-agent-
  // aware tools route results / context back to the parent if needed.
  // Undefined at the top level.
  parentSessionId?: string;
  // The effective tool-name surface of the CALLING turn (after any
  // allow/deny filtering). Tools that mint future work (cron_jobs create)
  // stamp this onto the created job so a constrained context (channel
  // sub-turn, filtered heartbeat) can't schedule itself an escalated tool
  // surface. Undefined = the caller ran with the full registry.
  allowedToolNames?: string[];
  // Per-run egress allow-list (domain suffixes) for the net-guarded fetch tools
  // (web_fetch, attach_url_file). When set, those tools may reach ONLY these
  // domains — the per-job containment that stops an injected autonomous run from
  // exfiltrating to an arbitrary public host. Undefined = no egress restriction
  // (the SSRF block still applies). Set by the cron executor from a job's
  // egressDomains; unset for chat.
  egressAllowList?: string[];
  // True when this is a NON-interactive autonomous run (a scheduled cron job) —
  // no human is present. Set by the cron executor. Tools that key safety on
  // human presence read it: write_file/edit_file refuse to overwrite the agent's
  // prompt-loaded identity files (self-injection), and bash honors the optional
  // MANTLE_CRON_NO_BASH gate. Unset/false for chat.
  autonomous?: boolean;
  // Aborts when the user cancels the turn (/stop) or the WS closes.
  // Tools that wrap killable work (child processes, fetch, MCP calls)
  // should propagate this so /stop terminates them mid-flight rather
  // than waiting for natural completion. Tools that can't honor it
  // safely ignore it.
  signal?: AbortSignal;
  // Stream live output back to the UI as the tool runs. Long-running
  // tools (bash, chunked-transfer fetches) call this for each chunk
  // they receive. The final ToolResult.content remains the canonical
  // full output sent to the model — progress is purely UI-visible.
  // Optional — tools that produce results all-at-once skip it.
  progress?: (event: ToolProgressEvent) => void;
  // The tool_use block id from the provider stream. Set by the agent
  // loop when invoking the tool; used by progress consumers (loop
  // forwards as `tool_call_progress.id`) so the UI can route chunks
  // back to the right tool bubble when multiple tools run in parallel.
  toolCallId?: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // Where the tool came from — "core" (default when unset), "englyph", or
  // "mcp:<server name>". Registration-time provenance for the UI's tool
  // surface (grouping now; per-server management later). Never sent to
  // providers (getDefinitions strips it).
  source?: string;
  execute: (input: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>;
}
