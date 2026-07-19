/**
 * Backend identity — id/vendor/mode types, vendor display labels, and the
 * legacy-name → composite-id migration. Deliberately free of provider-class
 * imports so the config loader and the `mantle` CLI can migrate ids without
 * dragging in the provider SDKs (@anthropic-ai/sdk, openai). catalog.ts
 * imports + re-exports everything here, so existing `… from "./catalog.js"`
 * call sites are unaffected.
 */

export type Vendor = "anthropic" | "openai" | "xai" | "google" | "local";
export type Mode = "api" | "subscription" | "local";
export type BackendId = string; // "anthropic/api", "xai/subscription", "local", …

export const VENDOR_LABELS: Record<Vendor, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  xai: "Grok",
  google: "Gemini",
  local: "Local",
};

// Old flat ProviderName / session-flag → composite id. Internal — every
// consumer goes through migrateLegacyBackendId.
const LEGACY_BACKEND_IDS: Record<string, BackendId> = {
  claude: "anthropic/api",
  grok: "xai/api",
  "openai-codex": "openai/subscription",
  "grok-build": "xai/subscription",
  local: "local",
};

export function migrateLegacyBackendId(id: string): BackendId {
  return LEGACY_BACKEND_IDS[id] ?? id;
}
