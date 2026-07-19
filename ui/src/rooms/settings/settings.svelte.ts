// Settings room state — the modal's open flag + the chat-effects preference
// (same localStorage key as the vanilla UI, so the choice survives the
// cutover). FxLayer reacts to `settings.fx`; the modal's Toggle drives it.
import { lsGet, lsSet } from '../../lib/storage';

const LS_FX = 'mantle-chat-effects';

export const settings = $state({
  open: false,
  // Active tab — also lets callers deep-link (e.g. a "configure a provider"
  // CTA can set tab='providers' before opening the modal).
  tab: 'general' as 'general' | 'providers' | 'features' | 'connections',
  fx: lsGet(LS_FX) === 'true',
});

export function setFx(on: boolean): void {
  settings.fx = on;
  lsSet(LS_FX, String(on));
}
