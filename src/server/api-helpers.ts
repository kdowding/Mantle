// Tiny response helpers shared by the api-* route modules.

export function json(data: unknown, status = 200): Response {
  // No CORS header by design: MANTLE is a same-origin SPA (the Bun server
  // serves the UI and the API on one origin; the Vite dev server proxies
  // same-origin). A wildcard Access-Control-Allow-Origin would only widen the
  // attack surface — letting any web page read these responses — for zero
  // benefit. Cross-origin browser reads are meant to be blocked.
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Parse a JSON request body, returning null on a missing/malformed payload so
// call sites answer a clean 400 instead of throwing into the 500 boundary.
export async function readJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
