// Persona switcher state + actions — the runes replacement for app.js
// loadPersonas / loadSessionPersona / selectPersona. The server resolves the
// active persona per turn (session meta → personas.json currentState) and
// stamps it onto the session on every message, so the UI only persists the
// choice on select — nothing rides the WS payload.
import { ui, chat } from './state.svelte';
import { getPersonas, getSessionPersona, putPersonasState, putSessionPersona, type PersonaProfile } from './api';

export const personas = $state({
  available: false,
  current: null as string | null,
  profiles: {} as Record<string, PersonaProfile>,
});

// Fetch the agent's personas.json (called on agent switch). Resets first so
// an agent without personas hides the pill; stale-guarded against a newer
// switch landing mid-fetch.
export async function loadPersonas(): Promise<void> {
  const agentId = ui.currentAgentId;
  personas.available = false;
  personas.current = null;
  personas.profiles = {};
  if (!agentId) return;
  try {
    const data = await getPersonas(agentId);
    if (ui.currentAgentId !== agentId) return; // superseded
    if (!data.available || Object.keys(data.profiles ?? {}).length === 0) return;
    personas.available = true;
    personas.profiles = data.profiles;
    personas.current = data.currentState;
  } catch {
    // unreachable personas.json reads as "no personas" — pill stays hidden
  }
}

// A selected session's own persona overrides the agent-level current (called
// on session select). Unknown names (profile since deleted) are ignored.
export async function loadSessionPersona(): Promise<void> {
  const agentId = ui.currentAgentId;
  const sessionId = chat.sessionId;
  if (!agentId || !sessionId) return;
  try {
    const { persona } = await getSessionPersona(agentId, sessionId);
    if (ui.currentAgentId !== agentId || chat.sessionId !== sessionId) return; // superseded
    if (persona && personas.profiles[persona]) personas.current = persona;
  } catch {
    // session may not have a persona set yet
  }
}

// Set locally + persist: to the session's meta (when one exists) and to
// personas.json currentState (always) — both fire-and-forget, like the
// vanilla UI; the next turn picks it up server-side either way.
export function selectPersona(key: string): void {
  const agentId = ui.currentAgentId;
  if (!agentId || !personas.profiles[key]) return;
  personas.current = key;
  if (chat.sessionId) putSessionPersona(agentId, chat.sessionId, key).catch(() => {});
  putPersonasState(agentId, key).catch(() => {});
}
