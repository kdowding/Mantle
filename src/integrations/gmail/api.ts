// Gmail engine — the composition layer over the Gmail REST API. Plain fetch by
// design: the IntegrationBroker already owns auth (OAuth + refresh), so the
// SDK's main value is redundant, and the `googleapis` package is heavy. Each
// function takes an access token + args and returns a SHAPED result (the
// "view"); listMessages is the collapse example (list ids -> per-id metadata
// -> one summary). Swapping fetch for @googleapis/gmail later is a localized
// change here — the broker, tools, and contract don't care.

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

interface GmailHeader {
  name?: string;
  value?: string;
}
interface GmailPayload {
  headers?: GmailHeader[];
  body?: { data?: string };
  parts?: GmailPayload[];
  mimeType?: string;
}
interface GmailMessage {
  id?: string;
  snippet?: string;
  payload?: GmailPayload;
}

async function gfetch<T = unknown>(token: string, path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${GMAIL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Gmail ${resp.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function header(payload: GmailPayload | undefined, name: string): string {
  const h = payload?.headers?.find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decodeBody(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  if (payload.body?.data) {
    try {
      return Buffer.from(payload.body.data, "base64url").toString("utf8");
    } catch {
      return "";
    }
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      try {
        return Buffer.from(part.body.data, "base64url").toString("utf8");
      } catch {
        /* try next part */
      }
    }
  }
  for (const part of payload.parts ?? []) {
    const sub = decodeBody(part);
    if (sub) return sub;
  }
  return "";
}

export interface MessageSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export async function listMessages(
  token: string,
  opts: { query?: string; limit?: number } = {},
): Promise<MessageSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const q = opts.query ? `&q=${encodeURIComponent(opts.query)}` : "";
  const list = await gfetch<{ messages?: Array<{ id?: string }> }>(
    token,
    `/users/me/messages?maxResults=${limit}${q}`,
  );
  const ids = (list.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string")
    .slice(0, limit);
  return Promise.all(
    ids.map(async (id) => {
      const m = await gfetch<GmailMessage>(
        token,
        `/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      );
      return {
        id,
        from: header(m.payload, "From"),
        subject: header(m.payload, "Subject"),
        date: header(m.payload, "Date"),
        snippet: m.snippet ?? "",
      };
    }),
  );
}

export interface MessageDetail {
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

export async function getMessage(token: string, id: string): Promise<MessageDetail> {
  const m = await gfetch<GmailMessage>(token, `/users/me/messages/${id}?format=full`);
  return {
    from: header(m.payload, "From"),
    to: header(m.payload, "To"),
    subject: header(m.payload, "Subject"),
    date: header(m.payload, "Date"),
    body: decodeBody(m.payload).slice(0, 4000),
  };
}

export async function sendMessage(
  token: string,
  to: string,
  subject: string,
  body: string,
): Promise<{ id: string }> {
  const mime = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
  const raw = Buffer.from(mime, "utf8").toString("base64url");
  const res = await gfetch<{ id?: string }>(token, `/users/me/messages/send`, {
    method: "POST",
    body: JSON.stringify({ raw }),
  });
  return { id: res.id ?? "(unknown)" };
}
