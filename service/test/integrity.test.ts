import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import type { GitHub, Status } from '../src/github';
import type { ChangedFile } from '../src/hunks';
import { issueIdIn } from '../src/integrity';
import type { Answers, Ask } from '../src/jev';
import type { Linear } from '../src/linear';

let answers: Answers | null;
let asked: { state: any; questions: Record<string, unknown> }[];
let files: ChangedFile[];
let statuses: { sha: string; status: Status }[];
let comments: { pr: number; body: string }[];
let owner: string | null;

const ask: Ask = async (state, questions) => {
  asked.push({ state, questions });
  return answers;
};
const gh: GitHub = {
  verifyWebhook: async (_body, signature) => signature === 'good',
  pullFiles: async () => files,
  setStatus: async (_i, _o, _r, sha, status) => {
    statuses.push({ sha, status });
  },
  comment: async (_i, _o, _r, pr, body) => {
    comments.push({ pr, body });
  },
};
const linear = { getIssue: vi.fn(), createIssue: vi.fn(), updateIssue: vi.fn(), comment: vi.fn() } satisfies Linear;
const app = createApp({
  jev: () => ask,
  linear: () => linear,
  github: () => gh,
  access: () => async () => owner,
  convertManifest: async (code) => ({ id: 7, slug: 'parlornights-moderator', pem: `-----BEGIN PRIVATE KEY-----\n${code}`, webhook_secret: 'whsec', html_url: 'https://github.com/apps/x' }),
});

const event = (sha: string, action = 'synchronize') => ({
  action,
  installation: { id: 1 },
  repository: { name: 'CrookedDuke', full_name: 'parlornights/CrookedDuke', owner: { login: 'parlornights' } },
  pull_request: { number: 42, title: 'CD-7: players rename games', head: { sha }, user: { login: 'pr-author' } },
});

const decide = (sha: string, form: string) =>
  app.request(`/approve/parlornights/CrookedDuke/${sha}`, { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }, env);

async function hook(body: unknown, { signature = 'good', type = 'pull_request' } = {}) {
  const ctx = createExecutionContext();
  const res = await app.request('/github/webhook', { method: 'POST', headers: { 'X-Hub-Signature-256': signature, 'X-GitHub-Event': type }, body: JSON.stringify(body) }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const changed: ChangedFile = { filename: 'src/__tests__/score.test.ts', status: 'modified', patch: '@@ -1 +1 @@\n-  expect(total).toBe(120);\n+  expect(total).toBeGreaterThan(0);' };

beforeEach(() => {
  answers = null;
  asked = [];
  files = [];
  statuses = [];
  comments = [];
  owner = 'owner@example.com';
  vi.resetAllMocks();
  linear.getIssue.mockResolvedValue({ id: 'CD-7', title: 'Players rename games', description: 'Done when a new name survives a reload.' });
});

describe('webhook', () => {
  it('refuses a bad signature and ignores other events', async () => {
    expect((await hook(event('a1'), { signature: 'bad' })).status).toBe(401);
    expect((await hook(event('a1'), { signature: '' })).status).toBe(401);
    expect(await (await hook(event('a1'), { type: 'push' })).json()).toEqual({ ignored: true });
    expect(await (await hook(event('a1', 'closed'))).json()).toEqual({ ignored: true });
    expect(statuses).toEqual([]);
  });

  it('is green without asking Jev when no existing test changed', async () => {
    files = [{ filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }, { filename: 'src/new.test.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x' }];
    expect((await hook(event('a2'))).status).toBe(202);
    expect(statuses).toEqual([{ sha: 'a2', status: { state: 'success', description: 'No existing test changed', targetUrl: 'https://moderator.parlornights.com/approve/parlornights/CrookedDuke/a2' } }]);
    expect(asked).toEqual([]);
  });

  it('asks Jev per hunk with the ticket, and is red when one is unsanctioned', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('a3'));
    expect(linear.getIssue).toHaveBeenCalledWith('CD-7');
    expect(asked[0].state.ticket).toMatchObject({ id: 'CD-7' });
    expect(asked[0].state.hunks[0]).toMatchObject({ file: 'src/__tests__/score.test.ts' });
    expect(statuses[0].status).toMatchObject({ state: 'failure', description: "1 test change(s) need the owner's decision" });
    expect(comments).toEqual([{ pr: 42, body: expect.stringContaining('@pr-author **test-integrity** on a3') }]);
    expect(comments[0].body).toContain('https://moderator.parlornights.com/approve/parlornights/CrookedDuke/a3');
  });

  it('asks the question neutrally, with as many sanctioned samples as unsanctioned', async () => {
    files = [changed];
    answers = { h1: { noul: 0.9 } };
    await hook(event('n1'));
    const samples = asked[0].state.samples as { sanctioned: boolean }[];
    expect(samples.filter((x) => x.sanctioned).length).toBe(samples.filter((x) => !x.sanctioned).length);
  });

  it('judges every hunk of a large PR, in several Jev requests, untruncated', async () => {
    const long = `@@ -1 +1 @@\n-${'a'.repeat(5_000)}\n+${'b'.repeat(5_000)}`;
    files = Array.from({ length: 45 }, (_, n) => ({ filename: `src/__tests__/t${n}.test.ts`, status: 'modified', patch: long }));
    answers = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`h${n + 1}`, { noul: 0.9 }]));
    await hook(event('l1'));
    expect(asked.length).toBeGreaterThan(2);
    expect(asked.flatMap((a) => a.state.hunks).length).toBe(45);
    expect(asked[0].state.hunks[0].patch).toBe(long);
    expect(statuses[0].status).toMatchObject({ state: 'success', description: '45 test change(s), all sanctioned' });
  });

  it('is green when every hunk is sanctioned', async () => {
    files = [changed];
    answers = { h1: { noul: 0.9 } };
    await hook(event('a4'));
    expect(statuses[0].status).toMatchObject({ state: 'success', description: '1 test change(s), all sanctioned' });
  });

  it('is red when Jev does not answer, and flags a file GitHub shows no diff for', async () => {
    files = [changed];
    await hook(event('a5'));
    expect(statuses[0].status).toMatchObject({ state: 'failure', description: "Jev did not answer: the owner's decision is needed" });

    files = [{ filename: 'e2e/home.spec.ts-snapshots/home.png', status: 'modified' }];
    await hook(event('a6'));
    expect(asked).toHaveLength(1);
    expect(statuses[1].status).toMatchObject({ state: 'failure' });
  });
});

describe('approval page', () => {
  it('is closed without the owner signing in through Access', async () => {
    owner = null;
    expect((await app.request('/approve/parlornights/CrookedDuke/a3', {}, env)).status).toBe(403);
    expect((await app.request('/github/setup', {}, env)).status).toBe(403);
  });

  it('shows the flagged hunks and turns the status green for that commit only', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('b1'));
    const page = await (await app.request('/approve/parlornights/CrookedDuke/b1', {}, env)).text();
    expect(page).toContain('src/__tests__/score.test.ts');
    expect(page).toContain('toBeGreaterThan(0)');

    const res = await decide('b1', 'decision=approve');
    expect(res.status).toBe(303);
    expect(statuses.at(-1)).toMatchObject({ sha: 'b1', status: { state: 'success', description: 'Approved by owner@example.com' } });

    await hook(event('b1', 'reopened'));
    expect(statuses.at(-1)?.status).toMatchObject({ state: 'success', description: 'Approved by owner@example.com' });
    expect(asked).toHaveLength(1);

    await hook(event('b2'));
    expect(statuses.at(-1)).toMatchObject({ sha: 'b2', status: { state: 'failure' } });
  });

  it('rejects with the reason posted on the PR, and keeps the rejection on reruns of that commit', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('r1'));
    comments = [];
    expect((await decide('r1', 'decision=reject&reason=Keep+the+exact+total%3B+fix+the+scoring+instead.')).status).toBe(303);
    expect(statuses.at(-1)).toMatchObject({ sha: 'r1', status: { state: 'failure', description: 'Rejected by the owner: Keep the exact total; fix the scoring instead.' } });
    expect(comments).toEqual([{ pr: 42, body: expect.stringContaining('> Keep the exact total; fix the scoring instead.') }]);

    await hook(event('r1', 'reopened'));
    expect(statuses.at(-1)?.status).toMatchObject({ state: 'failure', description: expect.stringContaining('Rejected by the owner') });
    expect(asked).toHaveLength(1);
    expect((await decide('r1', 'decision=maybe')).status).toBe(400);
  });

  it('still posts the status and records the run when the PR comment fails', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    const comment = gh.comment;
    gh.comment = async () => {
      throw new Error('Resource not accessible by integration');
    };
    try {
      await hook(event('f1'));
    } finally {
      gh.comment = comment;
    }
    expect(statuses.at(-1)).toMatchObject({ sha: 'f1', status: { state: 'failure' } });
    expect((await app.request('/approve/parlornights/CrookedDuke/f1', {}, env)).status).toBe(200);
  });

  it('rejects without a reason too', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('r2'));
    await decide('r2', 'decision=reject');
    expect(statuses.at(-1)?.status.description).toBe('Rejected by the owner');
  });

  it('refuses a cross-site approval', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('c1'));
    expect((await app.request('/approve/parlornights/CrookedDuke/c1', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x=1' }, env)).status).toBe(403);
  });
});

describe('GitHub App setup', () => {
  it('offers the manifest form and shows the new App secrets once', async () => {
    const setup = await (await app.request('/github/setup', {}, env)).text();
    expect(setup).toContain('https://github.com/organizations/parlornights/settings/apps/new');
    expect(setup).toContain('statuses');
    const created = await (await app.request('/github/created?code=abc', {}, env)).text();
    expect(created).toContain('whsec');
    expect(created).toContain('https://github.com/apps/parlornights-moderator/installations/new');
  });
});

it('reads the issue id from the PR title', () => {
  expect(issueIdIn('CD-269: CI on wb')).toBe('CD-269');
  expect(issueIdIn('fix things')).toBeNull();
});
