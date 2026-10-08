// The Moderator service: Jev checks and Linear writes. The service holds every key; a session holds only
// MODERATOR_API_KEY. Its URL is moderatorUrl in moderator.config.json.

import crypto from 'node:crypto';

import { config } from './config.js';

/**
 * @param {string} method
 * @param {string} route
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
async function request(method, route, body) {
  const base = config()?.moderatorUrl;
  const key = process.env.MODERATOR_API_KEY;
  if (!base || !key) throw new Error('Moderator is not set up here: moderatorUrl in moderator.config.json and MODERATOR_API_KEY in the environment');
  const res = await fetch(`${base.replace(/\/$/, '')}${route}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = /** @type {any} */ (await res.json().catch(() => null));
  if (!res.ok) throw new Error(`Moderator ${method} ${route}: ${res.status}${data?.error ? ` ${data.error}` : ''}`);
  return data;
}

/**
 * Runs one Jev check on the service. The result, or null when it did not run (Jev down, the service unreachable or
 * not set up); the reason goes to stderr. A caller never blocks on null.
 * @param {string} check pick | reviewer | verdict | open-questions | needs-decision
 * @param {unknown} input
 * @returns {Promise<Record<string, any> | null>}
 */
export async function jev(check, input) {
  try {
    const r = await request('POST', `/tool/jev/${check}`, input);
    if (r?.outcome === 'done') return r.result;
    process.stderr.write(`moderator: Jev ${check} did not run: ${r?.reason ?? 'no answer'}\n`);
  } catch (e) {
    process.stderr.write(`moderator: Jev ${check} did not run: ${e instanceof Error ? e.message : e}\n`);
  }
  return null;
}

/**
 * A UUID derived from the request and the day, so running the same command twice files once (the service returns
 * what the first call made), while the same text on another day, such as a second release note, is a new write.
 * @param {unknown} body
 * @param {Date} [now]
 */
export function requestId(body, now = new Date()) {
  const h = crypto.createHash('sha256').update(JSON.stringify([body, now.toISOString().slice(0, 10)])).digest('hex');
  const variant = (8 | (parseInt(h[16], 16) & 3)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * @typedef {{ outcome: 'done', id: string, url: string } | { outcome: 'ask_owner', reason: 'jev_refused' | 'jev_down', jev?: unknown }} LinearOutcome
 */

export const linear = {
  /**
   * @param {{ team: string, title: string, description: string, project?: string, parent?: string }} issue
   * @returns {Promise<LinearOutcome>}
   */
  createIssue: (issue) => request('POST', '/tool/linear/issue', { id: requestId(issue), ...issue }),

  /**
   * @param {string} id
   * @param {{ title?: string, description?: string, status?: string, priority?: number, addLabels?: string[], removeLabels?: string[], links?: { url: string, title: string }[] }} patch
   * @returns {Promise<LinearOutcome>}
   */
  updateIssue: (id, patch) => request('PATCH', `/tool/linear/issue/${encodeURIComponent(id)}`, patch),

  /**
   * @param {string} issue
   * @param {string} body
   * @returns {Promise<LinearOutcome>}
   */
  comment: (issue, body) => request('POST', '/tool/linear/comment', { id: requestId({ issue, body }), issue, body }),
};
