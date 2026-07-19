// Multi-agent group-chat ("channel") types — a self-contained, bolt-on feature.
//
// A channel is a Discord-style hangout: the user + N called-in companion
// agents share ONE author-tagged transcript, taking turns. It is deliberately
// isolated from the core 1:1 loop — everything lives under src/agent/channel/
// + src/server/channel-* + ui/channel.*, and the core is touched only by a
// handful of one-line `// [channel]` hooks. To remove the feature: delete
// those dirs + the marked hooks. Nothing here modifies a core type.

import type { SessionMessage } from "../../agent/session.js";
import type { ToolDefinition } from "../../agent/providers/types.js";

// Who authored a channel row. Denormalizes name + accentColor onto the row so
// the POV prefix and the UI bubble theming never need a config lookup and
// survive a later-purged agent.
export type ChannelAuthor =
  | { kind: "user" }
  | { kind: "agent"; agentId: string; name: string; accentColor?: string };

// An emoji reaction on a channel row. `by` is "user" or an agentId — a
// (by, emoji) pair is unique on a row. Rides as an extra JSON property (like
// `author`), invisible to core SessionMessage.
export interface ChannelReaction {
  emoji: string;
  by: string; // "user" | agentId
}

// A private aside ("whisper") scope on a channel row: the row is visible to
// the USER plus exactly these agents — every other agent's POV projection
// drops it as if it never happened. Stamped on the user's whisper message and
// inherited by every row the whispered agents author while answering it.
// Rides as an extra JSON property (like `author`).
export interface ChannelWhisper {
  to: string[]; // agentIds pulled aside (⊆ participants at stamp time)
}

// The author key the UI / store use for a user's own reactions.
export const REACTION_USER = "user";

// A channel transcript row. A SessionMessage with extra optional fields — they
// ride through SessionManager's JSONL as extra JSON properties, so core
// SessionMessage is never modified (the bolt-on guarantee).
export type ChannelMessage = SessionMessage & {
  author?: ChannelAuthor;
  reactions?: ChannelReaction[];
  whisper?: ChannelWhisper;
};

export interface ChannelModelOverride {
  provider?: string;
  model?: string;
}

// How the volley picks the next speaker after each agent finishes.
//   - "free": an agent's @-mention hands the floor to whoever they tagged;
//     with no @, it rotates to the next live-mic (auto-respond) agent.
//   - "round-robin": strict rotation through the live-mic agents only;
//     @-mentions in replies are ignored for routing.
export type ChannelVolleyStyle = "free" | "round-robin";

// Per-channel volley ("riff") config. When enabled, after the opening speakers
// answer the user, the called-in agents keep talking to EACH OTHER for up to
// maxTurns total agent turns (counting the opening replies) before control
// returns to the user. maxTurns is clamped to [1, VOLLEY_CAP] by the store.
export interface ChannelVolley {
  enabled: boolean;
  maxTurns: number;
  style: ChannelVolleyStyle;
}

// Defaults for a brand-new channel: volley off, a short 3-turn budget, free
// style. All flippable live in the channel UI; off keeps pure @-routing.
export const VOLLEY_DEFAULTS: ChannelVolley = { enabled: false, maxTurns: 3, style: "free" };

// Channel registry entry (persisted in .mantle/channels/index.json).
export interface ChannelMeta {
  id: string;
  title: string;
  // Called-in agentIds = the active roster. The available-but-not-called-in
  // agents are just config.agents[] minus this set; not stored here.
  participants: string[];
  // Agents set to "auto-respond" (a live mic) — they answer every user message
  // without needing an @-mention. Always a subset of participants (the store
  // self-heals this on read / on dismiss). The opening speaker queue is
  // [...autoRespond (roster order), ...@'d-not-already (mention order)].
  autoRespond: string[];
  // The volley ("riff") config — agent↔agent back-and-forth after the opening
  // replies. See ChannelVolley. Backfilled to VOLLEY_DEFAULTS on read for
  // channels created before the feature existed.
  volley: ChannelVolley;
  // Pre-inference Englyph memory pack per speaker sub-turn (the same retrieval
  // the 1:1 chat runs on every user message, against each speaker's own
  // store). Off by default — every speaker turn costs an Englyph round-trip.
  // Backfilled to false on read.
  memoryPack: boolean;
  // The last agent that spoke — an un-@'d user message routes here.
  lastActiveAgentId?: string;
  // Sticky per-agent provider/model override (mirrors the 1:1 profile-bar
  // picker), fed straight into resolveProviderTurn per sub-turn.
  modelOverrides: Record<string, ChannelModelOverride>;
  createdAt: string;
  lastMessageAt: string;
}

// One participant as described to another agent in the group-chat prompt block.
export interface ChannelParticipant {
  id: string;
  name: string;
  blurb?: string;
}

// Injected into the dynamic zone of a speaking agent's system prompt (composed
// in the channel module, NOT in prompt-builder.ts).
export interface GroupChatOptions {
  selfName: string;
  // The human's display name (getUserName() at the call site → "the user" when
  // unset). Threaded in rather than read from prompt-builder here so the block
  // builder stays pure + unit-testable.
  userName: string;
  others: ChannelParticipant[];
  // Set when another agent just @'d this one into the conversation.
  calledInBy?: string;
  // Present only during an ENABLED volley. Drives the prompt's "riff" guidance
  // and the channel_yield mention (the tool is injected only when this is set).
  volley?: { style: ChannelVolleyStyle };
  // Web tools actually registered this turn (brave_web_search / web_fetch) —
  // renders the "you can look things up" etiquette line with real names.
  webTools?: string[];
  // Present when this sub-turn answers a private aside: the OTHER whisper
  // members' names (may be empty — a 1-on-1 aside). Renders the "this is
  // just between you and the user" prompt block.
  whisper?: { with: string[] };
}

// Absolute hard ceiling on agent turns in a single volley, regardless of the
// channel's configured maxTurns (which the store/API clamp to <= this). The
// runaway backstop: even a "free"-style @-handoff riff that keeps pulling in
// fresh agents can't exceed this many turns before the floor returns to the
// user. The user-facing turns stepper tops out here.
export const VOLLEY_CAP = 12;

// The channel-only "pass the floor" pseudo-tool. NOT a registered registry
// tool — it's injected into the speaking agent's tools array (and described in
// the prompt) ONLY during an enabled volley, and intercepted by the channel
// controller's executeToolCall closure, so it never reaches the registry.
// Calling it means "I have nothing to add this round": the controller drops
// the agent from the rotation, and when every live-mic agent has yielded the
// volley ends early and the floor returns to the user.
export const CHANNEL_YIELD_TOOL_NAME = "channel_yield";

export const CHANNEL_YIELD_TOOL: ToolDefinition = {
  name: CHANNEL_YIELD_TOOL_NAME,
  description:
    "Pass the floor. Call this when you genuinely have nothing meaningful to " +
    "add to the current group conversation — it ends your turn without forcing " +
    "a reply, so the hangout can wind down naturally. If you DO have something " +
    "to say (a reaction, a question, a different take), just say it instead.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

// The channel-only "react with an emoji" pseudo-tool — like channel_yield, it is
// NOT a registry tool; it's injected into the speaking agent's tools array and
// intercepted by the controller's executeToolCall closure (it reacts to the most
// recent message, then pushes a channel_reaction event to the UI). Lets agents
// react to each other the way people do in a group chat, with zero extra tokens.
export const CHANNEL_REACT_TOOL_NAME = "channel_react";

export const CHANNEL_REACT_TOOL: ToolDefinition = {
  name: CHANNEL_REACT_TOOL_NAME,
  description:
    "React to the message you're replying to with a single emoji — a " +
    "lightweight way to show you noticed, agree, laughed, etc. without taking a " +
    "full turn. Pass exactly one emoji. Use it sparingly, like a real group chat; " +
    "if you have something to say, just reply with words instead.",
  inputSchema: {
    type: "object",
    properties: { emoji: { type: "string", description: "A single emoji, e.g. 😂 👍 🔥 ❤️" } },
    required: ["emoji"],
    additionalProperties: false,
  },
};

// The tool surface inside a channel: recall + light web lookup. No bash / fs /
// spawn — a hangout reads shared memory and checks a fact, it doesn't run a
// shell. The controller filters the live registry to those of these names that
// are actually registered (englyph_* + the memory tools exist only when Englyph
// is connected; brave_web_search only when the Brave MCP server is configured).
export const CHANNEL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "recall",
  "recall_source",
  "englyph_search",
  "memory_status",
  "web_fetch",
  "brave_web_search",
]);

// The subset of CHANNEL_TOOL_NAMES that reaches the web — used to render the
// prompt's "you can look things up" line only when at least one is registered.
export const CHANNEL_WEB_TOOL_NAMES: readonly string[] = ["brave_web_search", "web_fetch"];
