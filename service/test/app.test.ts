import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import type { Answers, Ask } from '../src/jev';
import type { Linear } from '../src/linear';

let answers: Answers | null;
let asked: { state: unknown; questions: Record<string, unknown> }[];
const linear = { createIssue: vi.fn(), updateIssue: vi.fn(), comment: vi.fn() } satisfies Linear;

const ask: Ask = async (state, questions) => {
  asked.push({ state, questions });
  return answers;
};
const app = createApp({ jev: () => ask, linear: () => linear });

const call = (path: string, init: RequestInit & { json?: unknown } = {}, key = 'key-one') =>
  app.request(
    path,
    {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    },
    env,
  );
const auditRows = async () => (await (await call('/audit')).json()) as { action: string; outcome: string; jev: unknown }[];

beforeEach(() => {
  answers = null;
  asked = [];
  vi.resetAllMocks();
  linear.createIssue.mockResolvedValue({ id: 'PAR-1', url: 'https://linear.app/x/PAR-1' });
  linear.updateIssue.mockResolvedValue({ id: 'PAR-1', url: 'https://linear.app/x/PAR-1' });
  linear.comment.mockResolvedValue({ id: 'c1', url: 'https://linear.app/x/PAR-1#c1' });
});

describe('auth', () => {
  it('refuses a request without a key or with a wrong one', async () => {
    expect((await app.request('/audit', {}, env)).status).toBe(401);
    expect((await call('/audit', {}, 'nope')).status).toBe(401);
  });

  it('accepts every key in the comma-separated list', async () => {
    expect((await call('/audit', {}, 'key-one')).status).toBe(200);
    expect((await call('/audit', {}, 'key-two')).status).toBe(200);
  });
});

describe('POST /tool/jev/:check', () => {
  it('picks unit-deep for a complex ticket and asks when ambiguous', async () => {
    answers = { complexity: { score: 2.4 }, risky: { noul: 0.1 }, ambiguous: { noul: 0.8 } };
    const res = await call('/tool/jev/pick', { method: 'POST', json: { issue: 'PAR-1', brief: 'Migrate the rooms' } });
    expect(await res.json()).toEqual({ outcome: 'done', result: { unit: 'unit-deep', ask: true, complexity: 2.4, risky: 0.1, ambiguous: 0.8 } });
    expect(Object.keys(asked[0].questions)).toEqual(['complexity', 'risky', 'ambiguous']);
  });

  it('blocks a verdict criterion below the threshold', async () => {
    answers = { c1: { noul: 0.9 }, c2: { noul: 0.1 } };
    const res = await call('/tool/jev/verdict', { method: 'POST', json: { criteria: ['a', 'b'], diff: 'x' } });
    expect(await res.json()).toMatchObject({ result: { pass: false, block: [{ criterion: 'b', p: 0.1 }] } });
  });

  it('asks only asksOwner when there are no open questions', async () => {
    answers = { asksOwner: { noul: 0.9 } };
    const res = await call('/tool/jev/open-questions', { method: 'POST', json: { open_questions: '  ', last_message: 'Which icon?' } });
    expect(Object.keys(asked[0].questions)).toEqual(['asksOwner']);
    expect(await res.json()).toMatchObject({ result: { pass: true, asking: true, checks: { asksOwner: { pass: true, p: 0.9 } } } });
  });

  it('fails open questions that are not repeated, apart from asking', async () => {
    answers = { wellFormed: { noul: 0.9 }, repeated: { noul: 0.1 }, asksOwner: { noul: 0.1 } };
    const res = await call('/tool/jev/open-questions', { method: 'POST', json: { open_questions: '- Q1: x?', last_message: 'done' } });
    expect(Object.keys(asked[0].questions)).toEqual(['wellFormed', 'repeated', 'asksOwner']);
    expect(await res.json()).toMatchObject({ result: { pass: false, asking: false } });
  });

  it('sends the samples with the text it judges', async () => {
    answers = { decision: { noul: 0.2 } };
    const res = await call('/tool/jev/needs-decision', { method: 'POST', json: { escalation: 'what now?' } });
    expect(await res.json()).toMatchObject({ result: { pass: false } });
    expect(asked[0].state).toMatchObject({ escalation: 'what now?', samples: { decision: { acceptable: expect.any(Array), unacceptable: expect.any(Array) } } });
  });

  it('says the check did not run when Jev does not answer', async () => {
    const res = await call('/tool/jev/reviewer', { method: 'POST', json: { files: [], numstat: [], commits: [] } });
    expect(await res.json()).toEqual({ outcome: 'not_run', reason: 'jev_down' });
  });

  it('refuses an unknown check and a bad input', async () => {
    expect((await call('/tool/jev/nope', { method: 'POST', json: {} })).status).toBe(404);
    expect((await call('/tool/jev/pick', { method: 'POST', json: { brief: '' } })).status).toBe(400);
    expect(asked).toHaveLength(0);
  });
});

describe('Linear tools', () => {
  const issue = { team: 'PAR', title: 'Players rename games', description: 'Done when the name sticks.' };

  it('files the issue when Jev passes it', async () => {
    answers = { issue: { noul: 0.9 } };
    const res = await call('/tool/linear/issue', { method: 'POST', json: issue });
    expect(await res.json()).toEqual({ outcome: 'done', id: 'PAR-1', url: 'https://linear.app/x/PAR-1' });
    expect(linear.createIssue).toHaveBeenCalledWith(issue);
  });

  it('writes nothing and asks the owner when Jev refuses or is down', async () => {
    answers = { issue: { noul: 0.1 } };
    expect(await (await call('/tool/linear/issue', { method: 'POST', json: issue })).json()).toMatchObject({ outcome: 'ask_owner', reason: 'jev_refused' });
    answers = null;
    expect(await (await call('/tool/linear/issue', { method: 'POST', json: issue })).json()).toEqual({ outcome: 'ask_owner', reason: 'jev_down' });
    expect(linear.createIssue).not.toHaveBeenCalled();
  });

  it('updates status, labels and links without Jev, and judges changed text', async () => {
    const patch = { status: 'Done', priority: 2, addLabels: ['Bug'], links: [{ url: 'https://example.com/d', title: 'Design' }] };
    expect(await (await call('/tool/linear/issue/PAR-1', { method: 'PATCH', json: patch })).json()).toMatchObject({ outcome: 'done' });
    expect(asked).toHaveLength(0);
    expect(linear.updateIssue).toHaveBeenCalledWith('PAR-1', patch);

    answers = { text: { noul: 0.2 } };
    expect(await (await call('/tool/linear/issue/PAR-1', { method: 'PATCH', json: { description: 'tests pass' } })).json()).toMatchObject({ outcome: 'ask_owner' });
    expect(asked[0].state).toMatchObject({ text: 'tests pass' });
  });

  it('comments when Jev passes the comment', async () => {
    answers = { comment: { noul: 0.7 } };
    const res = await call('/tool/linear/comment', { method: 'POST', json: { issue: 'PAR-1', body: 'Merged in #4.' } });
    expect(await res.json()).toMatchObject({ outcome: 'done', id: 'c1' });
    expect(linear.comment).toHaveBeenCalledWith('PAR-1', 'Merged in #4.');
  });

  it('answers 502 and audits the error when Linear fails', async () => {
    answers = { comment: { noul: 0.7 } };
    linear.comment.mockRejectedValue(new Error('issue PAR-9 not found'));
    const res = await call('/tool/linear/comment', { method: 'POST', json: { issue: 'PAR-9', body: 'Merged.' } });
    expect(res.status).toBe(502);
    expect((await auditRows())[0]).toMatchObject({ action: 'linear/comment', outcome: 'error' });
  });

  it('validates the body', async () => {
    expect((await call('/tool/linear/issue', { method: 'POST', json: { title: 'x' } })).status).toBe(400);
    expect((await call('/tool/linear/issue/PAR-1', { method: 'PATCH', json: { priority: 9 } })).status).toBe(400);
  });
});

describe('GET /audit', () => {
  it('lists calls newest first and pages with before', async () => {
    await call('/tool/jev/reviewer', { method: 'POST', json: { files: [], numstat: [], commits: [] } });
    answers = { comment: { noul: 0.7 } };
    await call('/tool/linear/comment', { method: 'POST', json: { issue: 'PAR-1', body: 'Merged.' } });
    const rows = (await (await call('/audit?limit=2')).json()) as { id: number; action: string; outcome: string; jev: unknown }[];
    expect(rows.map((r) => [r.action, r.outcome])).toEqual([['linear/comment', 'done'], ['jev/reviewer', 'not_run']]);
    expect(rows[0].jev).toMatchObject({ pass: true });
    const older = (await (await call(`/audit?before=${rows[0].id}`)).json()) as { action: string }[];
    expect(older[0].action).toBe('jev/reviewer');
  });
});
