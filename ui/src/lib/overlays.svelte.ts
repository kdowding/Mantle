// Open-overlay registry. Anchored Popovers register here while open so a
// surface-level Escape handler (e.g. the systems deck closing itself) can defer
// to an open dropdown — Escape should retract the dropdown first, not the page
// behind it. svelte:window keydown listeners fire in registration order (which
// varies by mount order across components), so a shared count is more robust
// than trying to stopPropagation between two window-level handlers. The count
// reflects the pre-Escape state during the synchronous event (a Popover's own
// Escape sets open=false, but its decrement runs in an $effect afterward), so
// the surface defers this press and closes on the next one.
export const overlays = $state({ popoverCount: 0 });

export function anyPopoverOpen(): boolean {
  return overlays.popoverCount > 0;
}
