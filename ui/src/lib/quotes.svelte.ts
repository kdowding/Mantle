// Quote rotation — the profile-bar / lobby tagline cycles through the agent's
// quotes.json every 60s. Port of app.js displayRandomQuote: persona-targeted
// bucket when the active persona has one (e.g. "playful" vs "thinking"),
// else the union of every bucket (covers agents with no personas.json and the
// flat-array quotes format the server stores under `default`), else the
// agent's IDENTITY tagline.
import { ui } from './state.svelte';
import { personas } from './personas.svelte';

export const quote = $state({ text: '' });

export function pickQuote(): void {
  const map = ui.profile?.quotes ?? null;
  let chosen: string | null = null;
  if (map) {
    const personaQuotes = personas.current ? map[personas.current] : null;
    if (personaQuotes && personaQuotes.length > 0) {
      chosen = personaQuotes[Math.floor(Math.random() * personaQuotes.length)];
    } else {
      const all = Object.values(map).flat();
      if (all.length > 0) chosen = all[Math.floor(Math.random() * all.length)];
    }
  }
  quote.text = chosen ?? ui.profile?.tagline ?? '';
}

// Pick now + every 60s; the caller's $effect re-runs this on agent/persona
// change (it reads ui.profile + personas.current there).
export function startQuoteRotation(): () => void {
  pickQuote();
  const t = setInterval(pickQuote, 60000);
  return () => clearInterval(t);
}
