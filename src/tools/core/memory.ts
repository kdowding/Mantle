import type { Tool } from "../types.js";
import type { ToolRegistry } from "../registry.js";

/**
 * Higher-level memory tools that wrap Englyph's raw MCP tools.
 * Targets the companion deployment (4 speech-act types, 6 companion
 * intents). Deployment is set on the store at create time, not via env.
 */
export function createMemoryTools(registry: ToolRegistry): Tool[] {
  // All memory wrappers register into the registry unconditionally. What the
  // AGENT sees is filtered at exposure time (ws.ts handleChat): the chat agent
  // gets the retrieval-only surface (recall / recall_history / recall_area /
  // expand_memory / memory_status), while remember + recall_source stay
  // registered for internal callers — the pre-inference pack builder, and
  // remember for out-of-band authoring — but are hidden from the agent.
  // Authoring is not the live agent's job; the raw englyph_* tools are hidden
  // too (the wrappers cover retrieval in companion language, and the agent
  // can't write/delete).
  return [
    createRememberTool(registry),       // registered for out-of-band authoring; hidden from the chat agent
    createRecallTool(registry),
    createRecallHistoryTool(registry),
    createRecallAreaTool(registry),
    createExpandMemoryTool(registry),
    createRecallSourceTool(registry),   // registered for internal use; hidden from the chat agent (source feature being redone)
    createMemoryStatusTool(registry),
  ];
}

function createRememberTool(registry: ToolRegistry): Tool {
  return {
    name: "remember",
    description: `Store something worth keeping across sessions in long-term companion memory (Englyph). Use for the user's wants, preferences, opinions, and biographical observations — background knowledge that makes future conversations feel continuous.

**Frame, don't log.** Memories are interpretive narrative from your perspective with forward intent, not quoted transcripts. A good memory reads usefully on its own a month from now.

Good: "Alex is planning to check out the new pho place this week. Worth asking how it went if they don't bring it up."
Bad:  "User said: 'I'm going to try that new pho place this week.'"

**Write in the vocabulary an expected query would use.** The embedder places content near queries that share its words — generic vocabulary lands in a crowded neighborhood; specific, distinctive vocabulary stays close to its intended queries. If you'd ask "does Alex like spicy food?" to retrieve this later, the memory should contain the words *Alex*, *spicy*, *food*.

Memory types (pick the most specific fit — this is the strongest scoring lever):
- **want** — forward-wanting: a goal, plan, request, or aspiration. The companion equivalent of a directive, without the command connotation (memories are read with judgement, not executed).
- **preference** — stable taste, habit, or likes/dislikes. What the user LIKES or habitually does.
- **opinion** — what the user thinks or believes — values, convictions, worldview. Distinct from preference: about how the world IS or SHOULD BE, not about what they personally like.
- **observation** — residual catch-all: atomic biographical fact or current-state note that doesn't fit the above. Safe default when unsure. Never the primary answer when a more specific type fits.`,
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The framed memory. Self-contained, interpretive, written from your perspective, and phrased in the vocabulary an expected query would use.",
        },
        memory_type: {
          type: "string",
          enum: ["want", "preference", "opinion", "observation"],
          description: "want=forward-wanting (goal/plan), preference=stable taste/habit, opinion=what user thinks/believes about the world, observation=residual biographical fact or state.",
        },
        topic: {
          type: "string",
          description: "Broad topic (Englyph wing). Examples: 'food', 'work', 'family', 'health', 'rev-mantle'. Drawers in the same wing share a retrieval namespace.",
        },
        subtopic: {
          type: "string",
          description: "More specific sub-topic within the topic (Englyph room). Optional — defaults to 'general'. Drawers in the same room are often retrieved together.",
        },
        source: {
          type: "string",
          enum: ["user", "agent", "observation"],
          description: "Who originated this memory. user=stated by the user, agent=you framed it from inference, observation=you noticed it during tool use or session review.",
        },
      },
      required: ["content", "memory_type", "topic", "source"],
    },
    async execute(input, context) {
      const content = String(input.content);
      const memoryType = String(input.memory_type);
      const topic = String(input.topic).toLowerCase().replace(/\s+/g, "-");
      const subtopic = input.subtopic ? String(input.subtopic).toLowerCase().replace(/\s+/g, "-") : "general";
      const source = String(input.source);

      const addedBy = source === "user" ? "user" : source === "agent" ? "agent" : "observation";

      const result = await registry.execute("englyph_add_drawer", {
        wing: topic,
        room: subtopic,
        content,
        agent: addedBy,
        memory_type: memoryType,
        source_file: `mantle-session`,
      }, context);

      return result;
    },
  };
}

function createRecallTool(registry: ToolRegistry): Tool {
  return {
    name: "recall",
    description: `Search long-term companion memory (Englyph) and get back an ordered narrative set to synthesize from — not a single answer.

Use at session start, when the user references something from a past session, or when you need context you don't have. Default limit is 5; raise it for a fuller picture, lower it when you're checking a specific fact.

Results are dated and flag currency — a value marked superseded/outdated/removed is NOT current, so trust the markers over raw recency. For how something changed over time use \`recall_history\`; for everything about a whole area use \`recall_area\`.

**Query in the vocabulary the stored memory would use.** Specific words and distinctive phrases work best — the embedder places your query next to content that shares its words. "What does Alex like to eat?" beats "food stuff." Generic queries return diffuse results.

Pick the intent honestly — the intent × type matrix moves rankings, and a wrong intent moves them in the wrong direction:
- **procedural** — "what did the user tell me to do" (boosts wants)
- **preference** — "what does the user like or prefer" (boosts preferences)
- **reflection** — "what does the user think about X" (boosts opinions)
- **state_check** — "how is the user doing / where are they at" (boosts observations)
- **recall** — "when did X happen / what did we do about Y" (boosts observations)
- **general** — no specific intent; balanced type ordering (use when unsure)

Empty results are preferred to noisy ones. If nothing good surfaces, say so rather than forcing a weak match.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Specific concepts and distinctive vocabulary work best; generic queries return diffuse results.",
        },
        intent: {
          type: "string",
          enum: ["procedural", "preference", "reflection", "state_check", "recall", "general"],
          description: "What you're doing with this information. Routes to the intent × type scoring matrix.",
        },
        topic: {
          type: "string",
          description: "Limit search to a specific topic (wing). Optional — omit for broad search across all topics.",
        },
        limit: {
          type: "number",
          description: "Max results in the narrative set (default: 5). Raise for broader coverage, lower for a specific fact.",
        },
      },
      required: ["query"],
    },
    async execute(input, context) {
      const query = String(input.query);
      const intent = input.intent ? String(input.intent) : "general";
      const topic = input.topic ? String(input.topic).toLowerCase().replace(/\s+/g, "-") : undefined;
      const limit = Number(input.limit ?? 5);

      const result = await registry.execute("englyph_search", {
        query,
        query_intent: intent,
        wing: topic,
        n_results: limit,
      }, context);

      return result;
    },
  };
}

function createRecallHistoryTool(registry: ToolRegistry): Tool {
  return {
    name: "recall_history",
    description: `Trace how something evolved — a dated, chronological trail of one thing's values over time, latest marked as current. Reach for this on "how did X change", "what did we used to use", the arc of a project, or when a fact has clearly shifted across sessions. Returns the story (an ordered trail), not a flat ranked list.

**vs \`recall\`:** recall finds the current value / matching facts (ranked); recall_history reconstructs the timeline. **vs \`recall_area\`:** that gathers a whole area's breadth; this follows one thing through time.

Query in the vocabulary the memory would use — the entity that changed ("editor framework", "where I live"), not "history of…".`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The thing whose history to trace. Use the entity's own words.",
        },
        topic: {
          type: "string",
          description: "Optional topic (wing) to scope to. Omit for all topics.",
        },
        limit: {
          type: "number",
          description: "Max threads to surface (default 5).",
        },
      },
      required: ["query"],
    },
    async execute(input, context) {
      const query = String(input.query);
      const wing = input.topic ? String(input.topic).toLowerCase().replace(/\s+/g, "-") : undefined;
      const maxThreads = Number(input.limit ?? 5);
      return await registry.execute(
        "englyph_recall_thread",
        { query, wing, max_threads: maxThreads },
        context,
      );
    },
  };
}

function createRecallAreaTool(registry: ToolRegistry): Tool {
  return {
    name: "recall_area",
    description: `Gather everything about a whole area of the user's life or work — the complete set of facets, not a ranked few. "Everything about my fitness", "all the auth-project decisions". englyph collects by area membership, so it surfaces facets that don't share words with your query (a "rock climbing" memory for "what do I do for fun"). Use for breadth and completeness.

**vs \`recall\`:** recall ranks a few best matches; recall_area returns the whole set. **vs \`recall_history\`:** that follows one thing through time; this spreads across one area.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The area to gather, in natural words ('my hobbies', 'the billing project').",
        },
        area: {
          type: "string",
          description: "Optional explicit life-area: identity / health / fitness / food / relationships / work / finances / home / hobbies / tastes / beliefs / growth. Omit to let englyph resolve it from the query.",
        },
      },
      required: ["query"],
    },
    async execute(input, context) {
      const query = String(input.query);
      const area = input.area ? String(input.area).toLowerCase().trim() : undefined;
      return await registry.execute("englyph_gather", { query, area }, context);
    },
  };
}

function createExpandMemoryTool(registry: ToolRegistry): Tool {
  return {
    name: "expand_memory",
    description: `Pull the raw underlying detail behind a recalled memory when the framed version feels too compressed for what you need. Pass the memory's id (the drawer_id shown in recall results). Use sparingly — raw substrate is larger than the framed memory and burns context fast.`,
    inputSchema: {
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "The drawer_id of the memory to expand (from a recall result).",
        },
        max_chunks: {
          type: "number",
          description: "Cap on raw chunks returned. Optional — omit to let englyph size it.",
        },
      },
      required: ["memory_id"],
    },
    async execute(input, context) {
      const drawerId = String(input.memory_id);
      const maxChunks = input.max_chunks !== undefined ? Number(input.max_chunks) : undefined;
      return await registry.execute(
        "englyph_expand_raw",
        { drawer_id: drawerId, max_chunks: maxChunks },
        context,
      );
    },
  };
}

function createRecallSourceTool(registry: ToolRegistry): Tool {
  return {
    name: "recall_source",
    description: `Search ingested source code and docs (Englyph source chunks) and get back the actual code/doc snippets that match your query. This is code retrieval, not memory.

**Use this when the question is about how something actually works in code** — a function's implementation, a file's structure, a configuration, a specific doc reference. The result is raw code/doc text with file path + line range, not framed memory.

**vs \`recall\`:** \`recall\` returns interpretive memory about the user (wants/preferences/opinions/observations). \`recall_source\` returns literal code/doc snippets from ingested projects.

- "what does the user prefer about scoring" → \`recall\` (that's a memory)
- "how does the scoring function actually work" → \`recall_source\` (that's code)
- "what is MANTLE?" → \`recall\` first (memory about user's project), then \`recall_source\` if you need implementation detail

**Query in the vocabulary the code uses.** Function names, class names, module paths, distinctive identifiers beat generic phrasing. "OllamaEmbeddingFunction embed_query" beats "how does embedding work."

**Scoping:** the \`wing\` parameter limits results to one ingested project (e.g., \`englyph\`, \`mantle\`). Omit to search across all source chunks. Default limit is 5 — enough to see a function with neighbors.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Use the vocabulary the code/doc would use — function names, class names, distinctive identifiers.",
        },
        wing: {
          type: "string",
          description: "Limit to one ingested project. Examples: \"englyph\", \"mantle\". Omit to search across all source wings.",
        },
        limit: {
          type: "number",
          description: "Max results (default: 5). Raise for broader coverage of a feature area.",
        },
      },
      required: ["query"],
    },
    async execute(input, context) {
      const query = String(input.query);
      const wing = input.wing ? String(input.wing).toLowerCase().replace(/\s+/g, "-") : undefined;
      const limit = Number(input.limit ?? 5);

      const result = await registry.execute("englyph_search_source", {
        query,
        wing,
        n_results: limit,
      }, context);

      return result;
    },
  };
}

function createMemoryStatusTool(registry: ToolRegistry): Tool {
  return {
    name: "memory_status",
    description: "Check what's in long-term memory — total memories, topics (wings), and subtopics (rooms).",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async execute(_input, context) {
      return await registry.execute("englyph_status", {}, context);
    },
  };
}
