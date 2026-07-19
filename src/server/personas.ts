// Per-agent persona loading. An agent's personas.json holds a set of
// named "masks" (profiles) plus the currently-active one. Shared by the
// chat path (ws.ts handleChat) and the realtime call path (call-bridge.ts
// handleCallStart) — extracted here so neither has to own it and the two
// server modules don't import each other.

import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import type { PersonaProfile } from "../agent/prompt-builder.js";

export interface PersonasConfig {
  currentState: string;
  profiles: Record<string, PersonaProfile>;
  escapePhrases?: string[];
}

export function loadPersonas(workspacePath: string): PersonasConfig | null {
  const personasPath = resolve(workspacePath, "personas.json");
  if (!existsSync(personasPath)) return null;
  try {
    return JSON.parse(readFileSync(personasPath, "utf-8"));
  } catch {
    return null;
  }
}
