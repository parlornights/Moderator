export interface AuditEntry {
  action: string;
  input: unknown;
  jev?: unknown;
  outcome: string;
  response: unknown;
}

const MAX = 20_000;
function json(v: unknown): string | null {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  return s.length > MAX ? JSON.stringify({ truncated: s.slice(0, MAX) }) : s;
}

export async function record(db: D1Database, e: AuditEntry): Promise<void> {
  await db
    .prepare('INSERT INTO audit (at, action, input, jev, outcome, response) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), e.action, json(e.input), json(e.jev), e.outcome, json(e.response))
    .run();
}

/** Newest first; `before` is an id to page back from. */
export async function list(db: D1Database, limit: number, before?: number) {
  const { results } = await db
    .prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?')
    .bind(before ?? Number.MAX_SAFE_INTEGER, limit)
    .all<{ id: number; at: string; action: string; input: string; jev: string | null; outcome: string; response: string }>();
  return results.map((r) => ({ ...r, input: JSON.parse(r.input), jev: r.jev && JSON.parse(r.jev), response: JSON.parse(r.response) }));
}
