// The channel system-prompt block + composer. A speaking agent in a channel
// gets its OWN, UNMODIFIED system prompt (buildSystemPrompt over its workspace)
// with one extra block appended to the DYNAMIC zone describing the group-chat
// situation. prompt-builder.ts is therefore never touched — composition lives
// here, in the bolt-on module.
//
// The block tells the agent: who else is in the room, the @-etiquette for
// pulling another companion in (kept even in P1's single-agent case so the
// behavior is already in the model's repertoire when P2 lights up routing),
// to stay in persona, and to keep it SNAPPY — a channel is a hangout, not an
// essay session.

import type { SystemPromptInput } from "../../agent/providers/types.js";
import type { SystemPrompt } from "../../agent/prompt-builder.js";
import type { GroupChatOptions } from "./types.js";

// Build the "# Channel" dynamic-zone block. Pure + dependency-light so it can
// be unit-checked in isolation (synthetic GroupChatOptions in, string out).
export function buildChannelBlock(opts: GroupChatOptions): string {
  const lines: string[] = ["# Channel", ""];

  lines.push(
    `You're in a group channel — a shared hangout with ${opts.userName} and, ` +
      `when present, other companion agents. You are **${opts.selfName}**. ` +
      `Messages from others are prefixed with the speaker's name (e.g. "${opts.userName}: ...") ` +
      `so you can tell who said what; don't prefix your OWN replies that way — ` +
      `just speak as yourself.`,
  );

  if (opts.others.length > 0) {
    lines.push("", "## Who else is here");
    for (const p of opts.others) {
      lines.push(`- **${p.name}**${p.blurb ? ` — ${p.blurb}` : ""}`);
    }
  } else {
    lines.push(
      "",
      `Right now it's just you and ${opts.userName} in here. More companions can be pulled ` +
        "in later.",
    );
  }

  if (opts.calledInBy) {
    lines.push(
      "",
      `**${opts.calledInBy}** just pulled you into the conversation — jump in ` +
        `where it left off.`,
    );
  }

  if (opts.whisper) {
    const w = opts.whisper.with;
    lines.push(
      "",
      "## Private aside",
      w.length > 0
        ? `${opts.userName} pulled you aside together with ${w.map((n) => `**${n}**`).join(" and ")} — ` +
          `a private side-conversation inside the channel. The rest of the room ` +
          `can't see ANY of this exchange (the whisper or the replies), so speak ` +
          `freely — and don't fill the others in afterwards unless ${opts.userName} says to. ` +
          `@-mentions here can only hand the floor to someone already in the aside.`
        : `${opts.userName} pulled you aside — a private one-on-one inside the channel. The ` +
          `rest of the room can't see ANY of this exchange (the whisper or your ` +
          `reply), so speak freely — and don't fill the others in afterwards unless ` +
          `${opts.userName} says to.`,
    );
  }

  lines.push(
    "",
    "## Etiquette",
    "- To pull another companion into the conversation, @-mention them by id " +
      "(e.g. `@echo`). Only do it when you genuinely want their take — it hands " +
      "them the next turn.",
    "- Stay in your own persona and voice. You're one voice in the room, not a " +
      "narrator for everyone.",
    "- Keep it SNAPPY. This is a hangout, not an essay — short, conversational " +
      "turns. React, riff, ask, answer. Leave room for others to talk.",
    "- To react to the latest message without taking a full turn, call the " +
      "`channel_react` tool with a single emoji (😂 👍 🔥 …) — a lightweight " +
      "\"saw that / agreed / lol\". Use it sparingly, like a real group chat; if " +
      "you have something to say, just say it.",
  );

  if (opts.webTools && opts.webTools.length > 0) {
    lines.push(
      "- Need a real fact mid-hangout (a score, a release date, what something " +
        `costs)? You can look it up: ${opts.webTools.map((t) => `\`${t}\``).join(" / ")}. ` +
        "Drop the answer back in conversationally — don't paste a wall of results.",
    );
  }

  if (opts.volley) {
    lines.push(
      "",
      "## Riffing",
      "The room is in a free-flowing volley right now: you and the other " +
        `companions are talking to EACH OTHER, not just answering ${opts.userName}. React to ` +
        "what was just said, build on it, push back, ask a follow-up — like a " +
        "real group chat. Don't restate the whole thread; just add your bit.",
    );
    if (opts.volley.style === "free") {
      lines.push(
        "- Want a specific companion's take next? @-mention them and the floor " +
          "passes to them. Otherwise it moves around the room on its own.",
      );
    } else {
      lines.push(
        "- The floor rotates around the room automatically — no need to @ anyone " +
          "to keep it going.",
      );
    }
    lines.push(
      "- If you've got nothing real to add this round, call the `channel_yield` " +
        `tool to pass rather than padding out a reply. The floor returns to ${opts.userName} ` +
        "after a few turns no matter what.",
    );
  }

  return lines.join("\n");
}

// Compose a channel system prompt from an UNMODIFIED buildSystemPrompt result:
// append the channel block to the dynamic zone (so it stays out of the cached
// stable/persona zones and re-renders per turn). Returns a SystemPromptInput
// the provider accepts directly.
export function composeChannelSystemPrompt(
  base: SystemPrompt,
  opts: GroupChatOptions,
): SystemPromptInput {
  const block = buildChannelBlock(opts);
  const dynamic = [base.dynamic, block].filter((s) => s && s.trim()).join("\n\n---\n\n");
  return {
    stable: base.stable,
    persona: base.persona,
    dynamic,
  };
}
