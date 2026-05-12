// ════════════════════════════════════════════════════════════════════
//  In-process AUTH_REQUIRED event ring
// ════════════════════════════════════════════════════════════════════
//
// The MCP/CLI execution path runs in the same Node process as the
// dashboard's Express server, so we can hand off Golden Path prompts
// via an in-memory ring buffer instead of plumbing SSE/WebSocket
// channels through the relay.
//
// The dashboard polls /api/auth/recent-prompts every few seconds and
// pops the most recent prompt — which it then renders as a modal.

export interface AuthRequiredEvent {
  id: string;
  ts: number;
  provider: string;
  required_secrets: string[];
  auth_type: "PAT" | "OAUTH_PKCE" | "API_KEY";
  golden_path_url: string | null;
  instructions: string[];
  message: string;
}

const RING_SIZE = 16;
const ring: AuthRequiredEvent[] = [];

let nextId = 1;

export function pushAuthRequired(
  partial: Omit<AuthRequiredEvent, "id" | "ts">,
): AuthRequiredEvent {
  const event: AuthRequiredEvent = {
    ...partial,
    id: String(nextId++),
    ts: Date.now(),
  };
  ring.push(event);
  if (ring.length > RING_SIZE) ring.shift();
  return event;
}

/** Recent events newer than `sinceId` (or all when omitted). */
export function listAuthRequired(sinceId?: string): AuthRequiredEvent[] {
  if (!sinceId) return [...ring];
  const sinceNum = Number(sinceId);
  if (!Number.isFinite(sinceNum)) return [...ring];
  return ring.filter((e) => Number(e.id) > sinceNum);
}
