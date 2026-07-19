// @-mention parsing for channel turn routing. Pure + dependency-free so the
// client can mirror it for highlight/autocomplete while the SERVER stays
// authoritative for routing. A hallucinated @handle (@everyone, @nobody) is
// simply inert — it never matches an active participant, so it can't fire a
// dead hop.

// Extract @mentions from text, in first-appearance order, de-duped, keeping
// ONLY those that match an active participant id (case-insensitive). Greedy
// token match (`[a-z0-9_-]*`) means "@echo-2" captures "echo-2" rather than
// matching "echo" first — no separate longest-first pass needed.
export function parseMentions(text: string, activeIds: Iterable<string>): string[] {
  // Map lowercased id -> canonical (original-cased) id. Matching stays
  // case-insensitive for the user, but we return the CANONICAL participant id
  // because getAgent() resolves case-SENSITIVELY (loader: a.id === agentId).
  // Returning the lowercased token would drop any agent whose stored id has
  // uppercase (e.g. "ECHO" -> "echo" -> "no longer a known agent").
  const canon = new Map<string, string>();
  for (const id of activeIds) canon.set(id.toLowerCase(), id);

  const out: string[] = [];
  const seen = new Set<string>();
  const re = /@([a-z0-9][a-z0-9_-]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lc = m[1].toLowerCase();
    if (canon.has(lc) && !seen.has(lc)) {
      seen.add(lc);
      out.push(canon.get(lc) as string);
    }
  }
  return out;
}

// Resolve the OPENING speaker queue for a user message (volley-aware): the
// auto-respond ("live mic") agents first, in participant (roster) order, then
// any explicitly @-mentioned agents not already included, in mention order.
// De-duped, so an agent that is both a live mic AND @'d speaks once. Falls back
// to the last-active agent (if still a participant), else empty (caller prompts
// the user to @ someone). This is the auto-respond-aware successor to
// resolveInitialSpeakers — toggled agents first, @'s after.
export function resolveOpeningQueue(
  text: string,
  participants: string[],
  autoRespond: Iterable<string>,
  lastActiveAgentId: string | undefined,
): string[] {
  const participantSet = new Set(participants);
  const auto = new Set<string>();
  for (const id of autoRespond) if (participantSet.has(id)) auto.add(id);

  const queue: string[] = [];
  const seen = new Set<string>();
  // Live mics first, in roster order.
  for (const id of participants) {
    if (auto.has(id) && !seen.has(id)) {
      seen.add(id);
      queue.push(id);
    }
  }
  // Then @-mentions not already queued, in first-appearance order.
  for (const id of parseMentions(text, participants)) {
    if (!seen.has(id)) {
      seen.add(id);
      queue.push(id);
    }
  }
  if (queue.length > 0) return queue;
  if (lastActiveAgentId && participantSet.has(lastActiveAgentId)) return [lastActiveAgentId];
  return [];
}

// Pick the next speaker for a round-robin volley continuation: the live-mic
// agent that comes after `lastSpeakerId` in roster order (cycling), skipping
// any in `exclude` (agents that have yielded). Returns undefined when no
// eligible agent remains — including the solo-mic case where the only candidate
// is the agent who just spoke (we don't let one agent monologue to itself).
export function nextRoundRobinSpeaker(
  orderedAutoRespond: string[],
  lastSpeakerId: string | undefined,
  exclude: ReadonlySet<string>,
): string | undefined {
  const pool = orderedAutoRespond.filter((id) => !exclude.has(id));
  if (pool.length === 0) return undefined;
  if (pool.length === 1) return pool[0] === lastSpeakerId ? undefined : pool[0];
  if (!lastSpeakerId) return pool[0];
  const idx = pool.indexOf(lastSpeakerId);
  if (idx === -1) return pool[0];
  return pool[(idx + 1) % pool.length];
}

// Defensive: strip a parroted leading "SelfName: " an agent might echo (the
// POV transform prefixes OTHERS' lines that way, so a model can mimic it).
// Applied before re-parsing the reply for @mentions.
export function stripLeadingSelfPrefix(text: string, selfName: string): string {
  const re = new RegExp(`^\\s*${escapeRegExp(selfName)}\\s*:\\s*`, "i");
  return text.replace(re, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
