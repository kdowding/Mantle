// Activity room — ambient awareness of harness-initiated work. Claims the
// background-delivery stream off the ws seam (bg_delivery_* + every turn
// event tagged source:'background', which core dispatch must never render)
// and turns it into: an in-place transcript refresh when the delivery lands
// in the session you're LOOKING at, or a toast + sidebar unread dot when it
// lands elsewhere. Also observes message_end (claim:false) to keep the
// active session's last-seen bookkeeping current.
import { ui, chat, sessions } from '../../lib/state.svelte';
import { onWsEvent, type WsEvent } from '../../lib/ws';
import { loadSessions, selectSession } from '../../lib/sessions';
import { selectAgent } from '../../lib/agents';
import { markSeenBuilt, markSeenCount } from '../../lib/unread';

export interface Toast {
  id: number;
  text: string;
  sessionId?: string;
  agentId?: string;
}

export const activity = $state({
  toasts: [] as Toast[],
});

let nextToastId = 1;
const TOAST_MS = 7000;
const TOAST_CAP = 4;

export function pushToast(text: string, opts: { sessionId?: string; agentId?: string } = {}): void {
  const t: Toast = { id: nextToastId++, text, ...opts };
  activity.toasts.push(t);
  while (activity.toasts.length > TOAST_CAP) activity.toasts.shift();
  setTimeout(() => dismissToast(t.id), TOAST_MS);
}

export function dismissToast(id: number): void {
  const i = activity.toasts.findIndex((t) => t.id === id);
  if (i !== -1) activity.toasts.splice(i, 1);
}

export async function openToast(t: Toast): Promise<void> {
  dismissToast(t.id);
  if (!t.sessionId) return;
  if (t.agentId && t.agentId !== ui.currentAgentId) await selectAgent(t.agentId);
  await selectSession(t.sessionId);
}

async function onDeliveryEnd(ev: WsEvent): Promise<void> {
  const sessionId = typeof ev.sessionId === 'string' ? ev.sessionId : null;
  const agentId = typeof ev.agentId === 'string' ? ev.agentId : null;
  if (!sessionId) return;

  // Refresh counts for the sidebar (badge appears via isUnread compare).
  if (agentId === ui.currentAgentId) await loadSessions();

  if (sessionId === chat.sessionId && agentId === ui.currentAgentId) {
    // You're looking at it — re-pull the transcript so the delivery and the
    // agent's reply appear in place. No toast for what's on screen.
    await selectSession(sessionId);
    return;
  }

  const agentName = ui.agents.find((a) => a.id === agentId)?.name ?? agentId ?? 'agent';
  const title = sessions.list.find((s) => s.id === sessionId)?.title;
  const where = title ? ` → ${title.length > 44 ? `${title.slice(0, 44)}…` : title}` : '';
  const what = ev.source === 'cron' ? 'scheduled job reported in' : 'background task delivered';
  pushToast(`⌁ ${agentName} · ${what}${where}`, {
    sessionId,
    agentId: agentId ?? undefined,
  });
}

// A "notify"-delivery cron run (or one with no chat session to land in) —
// a toast is the whole delivery.
function onCronNotify(ev: WsEvent): void {
  const agentId = typeof ev.agentId === 'string' ? ev.agentId : undefined;
  const agentName = ui.agents.find((a) => a.id === agentId)?.name ?? agentId ?? 'agent';
  const summary = typeof ev.summary === 'string' && ev.summary ? ` - ${ev.summary.slice(0, 90)}` : '';
  pushToast(`◷ ${agentName} · ${String(ev.jobName ?? 'scheduled job')}${summary}`, { agentId });
}

let registered = false;
export function registerActivityWs(): void {
  if (registered) return;
  registered = true;

  // Claim the whole background stream — deliveries act here; the tagged
  // mid-turn events (text_delta etc. from the delivery loop) are absorbed
  // so they can never bleed into the visible chat. Cron deliveries ride the
  // same synthetic-turn pipeline tagged source:'cron'.
  onWsEvent(
    (type, ev) => ev.source === 'background' || ev.source === 'cron' || type.startsWith('bg_delivery') || type === 'cron_notify',
    (ev) => {
      if (ev.type === 'bg_delivery_end') void onDeliveryEnd(ev);
      else if (ev.type === 'cron_notify') onCronNotify(ev);
    },
  );

  // Observer: a finished turn in the ACTIVE session updates last-seen (the
  // sidebar must not badge the conversation you're having).
  onWsEvent(
    'message_end',
    () => {
      const sid = chat.sessionId;
      if (!sid) return;
      void loadSessions().then(() => {
        markSeenCount(sid, sessions.list.find((s) => s.id === sid)?.messageCount);
        markSeenBuilt(sid, chat.messages.filter((m) => !m.divider).length);
      });
    },
    { claim: false },
  );
}
