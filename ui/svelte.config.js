import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Standalone Svelte 5 (NOT SvelteKit). vitePreprocess enables <script lang="ts">.
export default { preprocess: vitePreprocess() };
