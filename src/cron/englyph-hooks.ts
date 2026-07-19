import type { CronJob, CronRunResult } from "./types.js";
import type { ToolRegistry } from "../tools/registry.js";

// ── Pre-run: Conditional Execution Check ────────────────────────────────────

export async function checkCondition(
  job: CronJob,
  registry: ToolRegistry,
): Promise<{ proceed: boolean; reason?: string }> {
  if (!job.englyph?.conditionalQuery) {
    return { proceed: true };
  }

  if (!registry.has("englyph_search")) {
    return { proceed: true }; // Englyph not available, skip check
  }

  try {
    const result = await registry.execute("englyph_search", {
      query: job.englyph.conditionalQuery,
      n_results: Math.max(job.englyph.conditionalThreshold ?? 1, 1),
    }, { agentId: job.agentId, sessionId: `cron:${job.id}` });

    if (result.isError) {
      console.log(`[MANTLE:cron:englyph] Conditional check failed for "${job.name}": ${result.content}`);
      return { proceed: true }; // On error, proceed anyway (don't block jobs due to Englyph issues)
    }

    const parsed = JSON.parse(result.content);
    const count = parsed.results?.length ?? 0;
    const threshold = job.englyph.conditionalThreshold ?? 1;

    if (count < threshold) {
      return {
        proceed: false,
        reason: `Conditional check: found ${count} memories, need ${threshold}`,
      };
    }

    return { proceed: true };
  } catch (err) {
    console.log(`[MANTLE:cron:englyph] Conditional check error for "${job.name}":`, err);
    return { proceed: true }; // Fail open
  }
}

// ── Pre-run: Context Enrichment ─────────────────────────────────────────────

export async function enrichContext(
  job: CronJob,
  registry: ToolRegistry,
): Promise<string | null> {
  if (!job.englyph?.recallContext) {
    return null;
  }

  if (!registry.has("englyph_search")) {
    return null;
  }

  try {
    const searchParams: Record<string, unknown> = {
      query: job.englyph.recallContext,
      n_results: 5,
    };
    if (job.englyph.recallIntent) {
      searchParams.query_intent = job.englyph.recallIntent;
    }

    const result = await registry.execute("englyph_search", searchParams, {
      agentId: job.agentId,
      sessionId: `cron:${job.id}`,
    });

    if (result.isError) {
      console.log(`[MANTLE:cron:englyph] Context recall failed for "${job.name}": ${result.content}`);
      return null;
    }

    const parsed = JSON.parse(result.content);
    const memories = parsed.results;
    if (!memories || memories.length === 0) {
      return null;
    }

    // Format memories as context block
    const lines = memories.map((m: { content: string; wing?: string; room?: string; score?: number }, i: number) =>
      `${i + 1}. [${m.wing ?? "?"}/${m.room ?? "?"}] ${m.content.slice(0, 500)}`
    );

    return `## Context from Memory\n\nRelevant memories recalled for this scheduled task:\n\n${lines.join("\n")}\n\n---\n\n`;
  } catch (err) {
    console.log(`[MANTLE:cron:englyph] Context recall error for "${job.name}":`, err);
    return null;
  }
}

// Slugify a job name into an englyph room name. An all-symbol name ("★★★")
// collapses to "" — callers fall back (storeOutcome uses the job id,
// analyzeHistory drops the room filter) instead of writing into a
// nameless room.
function roomSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ── Post-run: Store Execution Outcome ───────────────────────────────────────

export async function storeOutcome(
  job: CronJob,
  result: CronRunResult,
  registry: ToolRegistry,
): Promise<string | null> {
  const shouldStore = job.englyph?.storeOutcome;
  if (!shouldStore) return null;

  if (!registry.has("englyph_add_drawer")) {
    return null;
  }

  try {
    const roomName = roomSlug(job.name) || `job-${job.id.slice(0, 8)}`;

    const lines = [
      `Cron job "${job.name}" executed at ${new Date().toISOString()}`,
      `Status: ${result.status}`,
      `Duration: ${Math.round(result.durationMs / 1000)}s`,
    ];
    if (result.provider) lines.push(`Provider: ${result.provider}`);
    if (result.model) lines.push(`Model: ${result.model}`);
    if (result.summary) lines.push(`Summary: ${result.summary}`);
    if (result.error) lines.push(`Error: ${result.error}`);
    if (result.usage) {
      lines.push(`Tokens: ${result.usage.input_tokens ?? 0} in / ${result.usage.output_tokens ?? 0} out`);
    }

    const content = lines.join("\n");

    const addParams: Record<string, unknown> = {
      wing: "cron-history",
      room: roomName,
      content,
      agent: "auto",
      memory_type: "observation",
      source_file: `cron:${job.id}`,
      caused_by_task: job.name,
      causal_type: "consequence",
    };

    // Link to previous execution memory for causal chain
    if (job.state.lastEnglyphMemoryId) {
      addParams.parent_id = job.state.lastEnglyphMemoryId;
    }

    const storeResult = await registry.execute("englyph_add_drawer", addParams, {
      agentId: job.agentId,
      sessionId: `cron:${job.id}`,
    });

    if (storeResult.isError) {
      console.log(`[MANTLE:cron:englyph] Failed to store outcome for "${job.name}": ${storeResult.content}`);
      return null;
    }

    const parsed = JSON.parse(storeResult.content);
    return parsed.drawer_id ?? null;
  } catch (err) {
    console.log(`[MANTLE:cron:englyph] Store outcome error for "${job.name}":`, err);
    return null;
  }
}

// ── On-demand: Pattern Analysis ─────────────────────────────────────────────

export async function analyzeHistory(
  jobName: string | undefined,
  registry: ToolRegistry,
  agentId: string,
): Promise<string> {
  if (!registry.has("englyph_search")) {
    return "Englyph is not connected. Cannot analyze cron execution history.";
  }

  try {
    const searchParams: Record<string, unknown> = {
      query: jobName
        ? `cron job "${jobName}" execution history outcomes`
        : "cron job execution history outcomes errors patterns",
      n_results: 10,
      wing: "cron-history",
      query_intent: "recall",
    };

    if (jobName) {
      // All-symbol names slug to "" — skip the room filter rather than
      // querying a nameless room.
      const roomName = roomSlug(jobName);
      if (roomName) searchParams.room = roomName;
    }

    const result = await registry.execute("englyph_search", searchParams, {
      agentId,
      sessionId: `cron-analyze`,
    });

    if (result.isError) {
      return `Failed to query execution history: ${result.content}`;
    }

    const parsed = JSON.parse(result.content);
    const memories = parsed.results;

    if (!memories || memories.length === 0) {
      return jobName
        ? `No execution history found for job "${jobName}".`
        : "No cron execution history found in Englyph.";
    }

    const lines = [
      `## Cron Execution History${jobName ? ` — ${jobName}` : ""}`,
      "",
      `Found ${memories.length} execution records:`,
      "",
    ];

    for (const m of memories) {
      lines.push(`- ${m.content}`);
      lines.push("");
    }

    return lines.join("\n");
  } catch (err) {
    return `Error analyzing history: ${err instanceof Error ? err.message : String(err)}`;
  }
}
