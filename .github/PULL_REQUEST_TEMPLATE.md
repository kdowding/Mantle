## What & why

<!-- What does this change, and what problem does it solve?
     For features: link the issue where we discussed it first
     (see CONTRIBUTING.md — feature PRs without prior discussion
     may be declined for vision fit, not quality). -->

## Gates

All of these pass locally (CI runs the same set):

- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run check:arch`
- [ ] `bun test src`
- [ ] `bun run ui:build` + `bun run check:svelte` (0/0) — if the UI changed

## Notes

<!-- Anything the review should know: judgment calls, platform-specific
     behavior, follow-ups deliberately left out. -->
