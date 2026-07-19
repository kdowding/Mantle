// Steer-while-busy mailbox — the channel for talking to an agent MID-TURN
// without interrupting it.
//
// The lock model is binary: preempt (/stop) or "busy". A companion ten
// iterations into a research loop couldn't hear "also check X" or "I found
// the bug, it's in the loader" without being killed first. This mailbox is
// the third option: the user posts a NOTE, the running loop drains it at the
// top of its next iteration and folds it into the transcript as a user-role
// message — the model sees it with its next inference and decides for itself
// whether to adjust course, answer immediately, or finish what it's doing.
//
// Mechanics: runAgentLoop opens a mailbox keyed by its sessionId, drains it
// every iteration, and closes it in its finally. postTurnNote() returns false
// when no mailbox is open for that session (no in-process turn running —
// idle sessions), so callers can fall back to the normal
// busy refusal. Everything here is synchronous on one JS thread — there is no
// window where a posted note can race a closing mailbox and vanish; close()
// hands leftovers back to the loop, which persists them for the next turn.

const mailboxes = new Map<string, string[]>();

export interface TurnMailbox {
  // Take all queued notes (FIFO), emptying the box.
  drain: () => string[];
  // Unregister; returns any notes posted after the final drain so the caller
  // can persist them (they greet the model at the start of the next turn).
  close: () => string[];
}

export function openTurnMailbox(sessionId: string): TurnMailbox {
  // Last-opener-wins: a stale entry for this session (a crashed loop that
  // never closed) is replaced rather than shared.
  const queue: string[] = [];
  mailboxes.set(sessionId, queue);
  return {
    drain: () => queue.splice(0, queue.length),
    close: () => {
      if (mailboxes.get(sessionId) === queue) mailboxes.delete(sessionId);
      return queue.splice(0, queue.length);
    },
  };
}

// Post a note to a session's running turn. Returns false when no turn is
// listening (caller should refuse or fall back).
export function postTurnNote(sessionId: string, note: string): boolean {
  const queue = mailboxes.get(sessionId);
  if (!queue) return false;
  queue.push(note);
  return true;
}
