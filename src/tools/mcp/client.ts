import type { Subprocess } from "bun";
import type { ToolDefinition } from "../../agent/providers/types.js";

interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const SURROGATE_PROBE = /[\uD800-\uDFFF]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function scrubLoneSurrogates(value: unknown): unknown {
  if (typeof value === "string") {
    return SURROGATE_PROBE.test(value) ? value.replace(LONE_SURROGATE, "�") : value;
  }
  if (Array.isArray(value)) {
    return value.map(scrubLoneSurrogates);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubLoneSurrogates(v);
    }
    return out;
  }
  return value;
}

export class McpClient {
  private process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>();
  private tools: ToolDefinition[] = [];
  private buffer = "";
  private config: McpServerConfig;
  private readerRunning = false;
  // Set by the owner (e.g. EnglyphManager) to be notified when the adapter
  // process exits on its own, so it can evict this now-dead client and
  // re-spawn on the next call.
  onExit?: () => void;

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    console.log(`[MANTLE:mcp] Connecting to MCP server: ${this.config.name}`);

    this.process = Bun.spawn([this.config.command, ...this.config.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.config.cwd,
      env: {
        ...process.env,
        // Force UTF-8 stdio for any Python MCP server. On Windows a piped
        // stdin otherwise defaults to the locale codec (cp1252), mangling
        // multi-byte UTF-8 into lone surrogates (a curly quote → \udc9d) that
        // then can't be re-encoded downstream. Harmless to non-Python servers;
        // per-server config.env can still override it.
        PYTHONIOENCODING: "utf-8",
        ...this.config.env,
      },
    });

    // Detect the adapter dying on its own (crash / OOM / killed externally):
    // reject any in-flight requests instead of letting them hang to their
    // (10-min) timeout, drop the dead handle, and notify the owner so it can
    // evict this client and re-spawn. Skipped when disconnect() already
    // replaced the handle. Also surfaces a death *during* connect() right away
    // (the pending initialize rejects) instead of timing out.
    const spawned = this.process;
    void spawned.exited.then((code) => {
      if (this.process !== spawned) return; // replaced by disconnect/reconnect
      this.process = null;
      const err = new Error(`MCP adapter "${this.config.name}" exited (code ${code})`);
      for (const [, pending] of this.pendingRequests) pending.reject(err);
      this.pendingRequests.clear();
      this.onExit?.();
    });

    // Start reading stdout for JSON-RPC responses
    this.startReader();

    // Log stderr in background
    this.logStderr();

    // Initialize MCP protocol
    const initResult = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "rev-mantle", version: "0.1.0" },
    }) as { protocolVersion: string; capabilities: unknown; serverInfo?: { name: string } };

    console.log(`[MANTLE:mcp] ${this.config.name}: initialized (protocol ${initResult.protocolVersion})`);

    // Send initialized notification (no id, no response expected)
    await this.sendNotification("notifications/initialized", {});

    // Get available tools
    const toolsResult = await this.sendRequest("tools/list", {}) as { tools: McpToolDef[] };
    this.tools = (toolsResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));

    console.log(`[MANTLE:mcp] ${this.config.name}: ${this.tools.length} tools available`);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    // Default 10 minutes for tool calls — englyph_research spawns nested
    // claude sessions that can run minutes; keyword-search tools return in
    // <1s. One generous ceiling handles both without penalizing the slow ones.
    // Handshake methods (initialize, tools/list) keep a 30s ceiling via the
    // sendRequest default.
    //
    // When `signal` is provided and fires mid-call, sendRequest deletes the
    // pending request entry immediately, rejects the outer promise, and
    // unhooks the abort listener — late responses arriving over stdout are
    // dropped silently by handleLine (no map entry → no resolve target).
    // The MCP 2024-11-05 protocol has no per-request cancel notification
    // so the server keeps running; we just stop holding the client-side
    // state, which was the leak.
    const timeoutMs = options.timeoutMs ?? 600_000;
    const result = await this.sendRequest(
      "tools/call",
      { name, arguments: args },
      { timeoutMs, signal: options.signal },
    ) as { content: Array<{ type: string; text?: string }> };

    // Extract text content from the result
    const textParts = (result.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);

    return textParts.join("\n") || "(no output)";
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.tools];
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      console.log(`[MANTLE:mcp] Disconnecting: ${this.config.name}`);
      try {
        this.process.kill();
      } catch {
        // Process may already be dead
      }
      this.process = null;
    }

    // Reject pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("MCP client disconnected"));
    }
    this.pendingRequests.clear();
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const timeoutMs = options.timeoutMs ?? 30_000;
    const signal = options.signal;

    return new Promise((resolve, reject) => {
      // Fast-fail when caller's signal is already aborted — don't even
      // hit the wire.
      if (signal?.aborted) {
        reject(new Error(`MCP request aborted before send: ${method}`));
        return;
      }

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        const seconds = Math.round(timeoutMs / 1000);
        const toolHint = method === "tools/call" && params?.name
          ? ` (tool: ${params.name})`
          : "";
        reject(new Error(`MCP request timeout after ${seconds}s: ${method}${toolHint}`));
      }, timeoutMs);

      // Abort hook — drop the pending entry immediately so a late
      // response over stdout finds nothing to resolve and is no-op'd.
      // Without this delete, the entry sat in pendingRequests for up
      // to `timeoutMs` (10 min for tool calls) holding closures and
      // any allocations they captured.
      const onAbort = signal
        ? () => {
            this.pendingRequests.delete(id);
            clearTimeout(timeout);
            reject(new Error(`MCP request aborted: ${method}`));
          }
        : null;
      if (onAbort) {
        signal!.addEventListener("abort", onAbort, { once: true });
      }

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          if (onAbort) signal!.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          if (onAbort) signal!.removeEventListener("abort", onAbort);
          reject(reason);
        },
      });

      this.write(request);
    });
  }

  private async sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const notification = {
      jsonrpc: "2.0" as const,
      method,
      params,
    };
    this.write(notification);
    // Small delay to let the server process the notification
    await new Promise((r) => setTimeout(r, 100));
  }

  private write(data: unknown): void {
    if (!this.process?.stdin) {
      throw new Error("MCP process not connected");
    }
    // Lone UTF-16 surrogates (e.g. an emoji whose pair was split by a
    // text.slice on the JS side) are well-formed JSON when stringified
    // (escaped as \uXXXX), but Python's json.loads restores them to bare
    // surrogate code points which httpx can't UTF-8 encode downstream —
    // englyph's POST then 500s with UnicodeEncodeError. Scrub before
    // serializing so anything we ship to MCP is well-formed Unicode.
    const json = JSON.stringify(scrubLoneSurrogates(data)) + "\n";
    this.process.stdin.write(json);
    this.process.stdin.flush();
  }

  private startReader(): void {
    if (this.readerRunning || !this.process?.stdout) return;
    this.readerRunning = true;

    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();

    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          this.buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          let newlineIndex: number;
          while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (line) {
              this.handleLine(line);
            }
          }
        }
      } catch {
        // Reader closed
      }
      this.readerRunning = false;
    };

    readLoop();
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line);
    } catch {
      // Not JSON, might be a notification or log
      return;
    }

    // Match to pending request
    if (response.id !== undefined) {
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(`MCP error: ${response.error.message}`));
        } else {
          pending.resolve(response.result);
        }
      }
    }
  }

  private async logStderr(): Promise<void> {
    if (!this.process?.stderr) return;

    const reader = this.process.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        // Log MCP server stderr with prefix
        for (const line of text.split("\n").filter(Boolean)) {
          console.log(`[MANTLE:mcp:${this.config.name}] ${line}`);
        }
      }
    } catch {
      // Reader closed
    }
  }
}
