import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import type { Check, GitHub } from '../src/github';
import type { ChangedFile } from '../src/hunks';
import { issueIdIn, workStart, type PullRequestEvent } from '../src/integrity';
import type { Answers, Ask } from '../src/jev';
import type { Linear } from '../src/linear';

let answers: Answers | null;
let asked: { state: any; questions: Record<string, unknown> }[];
let files: ChangedFile[];
let commitDates: string[];
let checks: { sha: string; check: Check }[];
let comments: { pr: number; body: string }[];
let owner: string | null;

const ask: Ask = async (state, questions) => {
  asked.push({ state, questions });
  return answers;
};
const gh: GitHub = {
  verifyWebhook: async (_body, signature) => signature === 'good',
  pullFiles: async () => files,
  commitDates: async () => commitDates,
  setCheck: async (_i, _o, _r, sha, check) => {
    checks.push({ sha, check });
  },
  comment: async (_i, _o, _r, pr, body) => {
    comments.push({ pr, body });
  },
};
const linear = { ticketBefore: vi.fn(), createIssue: vi.fn(), updateIssue: vi.fn(), comment: vi.fn() } satisfies Linear;
const app = createApp({
  jev: () => ask,
  linear: () => linear,
  github: () => gh,
  access: () => async () => owner,
  convertManifest: async (code) => ({ id: 7, slug: 'parlornights-moderator', pem: `-----BEGIN PRIVATE KEY-----\n${code}`, webhook_secret: 'whsec', html_url: 'https://github.com/apps/x' }),
});

const event = (sha: string, action = 'synchronize', changed_files = files.length): PullRequestEvent & { action: string } => ({
  action,
  installation: { id: 1 },
  repository: { name: 'CrookedDuke', full_name: 'parlornights/CrookedDuke', owner: { login: 'parlornights' } },
  pull_request: { number: 42, title: 'CD-7: players rename games', head: { sha }, user: { login: 'pr-author' }, created_at: '2026-10-08T12:00:00Z', changed_files },
});

async function hook(body: unknown, { signature = 'good', type = 'pull_request' } = {}) {
  const ctx = createExecutionContext();
  const res = await app.request('/github/webhook', { method: 'POST', headers: { 'X-Hub-Signature-256': signature, 'X-GitHub-Event': type }, body: JSON.stringify(body) }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const decide = (sha: string, form: string) =>
  app.request(`/approve/parlornights/CrookedDuke/${sha}`, { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }, env);

const changed: ChangedFile = { filename: 'src/__tests__/score.test.ts', status: 'modified', patch: '@@ -1 +1 @@\n-  expect(total).toBe(120);\n+  expect(total).toBeGreaterThan(0);' };

beforeEach(() => {
  answers = null;
  asked = [];
  files = [];
  commitDates = ['2026-10-08T11:00:00Z'];
  checks = [];
  comments = [];
  owner = 'owner@example.com';
  vi.resetAllMocks();
  linear.ticketBefore.mockResolvedValue({ id: 'CD-7', title: 'Players rename games', description: 'Done when a new name survives a reload.', comments: [] });
});

describe('webhook', () => {
  it('refuses a missing or bad signature and ignores other events', async () => {
    expect((await hook(event('a1'), { signature: 'bad' })).status).toBe(401);
    expect((await hook(event('a1'), { signature: '' })).status).toBe(401);
    expect(await (await hook(event('a1'), { type: 'push' })).json()).toEqual({ ignored: true });
    expect(await (await hook(event('a1', 'closed'))).json()).toEqual({ ignored: true });
    expect(checks).toEqual([]);
  });

  it('is green without asking Jev when no existing test changed', async () => {
    files = [{ filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }, { filename: 'src/new.test.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x' }];
    expect((await hook(event('a2'))).status).toBe(202);
    expect(checks).toEqual([{ sha: 'a2', check: expect.objectContaining({ conclusion: 'success', title: 'No existing test changed', detailsUrl: 'https://moderator.parlornights.com/approve/parlornights/CrookedDuke/a2' }) }]);
    expect(asked).toEqual([]);
  });

  it('asks Jev with the ticket as it stood when the work began, and needs the owner when a hunk is unsanctioned', async () => {
    files = [changed];
    commitDates = ['2026-10-08T11:00:00Z', '2026-10-08T09:30:00Z'];
    answers = { h1: { noul: 0.1 } };
    await hook(event('a3'));
    expect(linear.ticketBefore).toHaveBeenCalledWith('CD-7', new Date('2026-10-08T09:30:00Z'));
    expect(asked[0].state.ticket).toMatchObject({ id: 'CD-7' });
    expect(checks[0].check).toMatchObject({ conclusion: 'action_required', title: "1 test change(s) need the owner's decision" });
    expect(comments).toEqual([{ pr: 42, body: expect.stringContaining('@pr-author **test-integrity** on a3') }]);
    expect(comments[0].body).toContain('https://moderator.parlornights.com/approve/parlornights/CrookedDuke/a3');
  });

  it('judges with no ticket when no ticket text predates the work', async () => {
    files = [changed];
    linear.ticketBefore.mockResolvedValue(null);
    answers = { h1: { noul: 0.1 } };
    await hook(event('t1'));
    expect(asked[0].state.ticket).toBe('(no ticket text written before this work began)');
  });

  it('is green when every hunk is sanctioned', async () => {
    files = [changed];
    answers = { h1: { noul: 0.9 } };
    await hook(event('a4'));
    expect(checks[0].check).toMatchObject({ conclusion: 'success', title: '1 test change(s), all sanctioned' });
    expect(comments).toEqual([]);
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
    expect(checks[0].check).toMatchObject({ conclusion: 'success', title: '45 test change(s), all sanctioned' });
  });

  it('flags a hunk Jev gave no answer for', async () => {
    files = [changed, { ...changed, filename: 'src/__tests__/other.test.ts' }];
    answers = { h1: { noul: 0.9 } };
    await hook(event('m1'));
    expect(checks[0].check).toMatchObject({ conclusion: 'action_required', title: "1 test change(s) need the owner's decision" });
  });

  it('needs the owner when Jev does not answer, and for a file GitHub shows no diff for', async () => {
    files = [changed];
    await hook(event('a5'));
    expect(checks[0].check).toMatchObject({ conclusion: 'action_required', title: "Jev did not answer: the owner's decision is needed" });

    files = [{ filename: 'e2e/home.spec.ts-snapshots/home.png', status: 'modified' }];
    await hook(event('a6'));
    expect(asked).toHaveLength(1);
    expect(checks[1].check).toMatchObject({ conclusion: 'action_required' });
  });

  it('needs the owner when GitHub lists fewer files than the PR changed', async () => {
    files = [{ filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }];
    await hook(event('p1', 'synchronize', 3500));
    expect(checks[0].check).toMatchObject({ conclusion: 'action_required' });
    expect(checks[0].check.summary).toContain('GitHub listed 1 of the PR\'s 3500 files');
  });

  it('leaves a red check and a decidable row when the run throws', async () => {
    files = [changed];
    linear.ticketBefore.mockRejectedValue(new Error('Linear is down'));
    await hook(event('e1'));
    expect(checks[0].check).toMatchObject({ conclusion: 'action_required', title: "The check errored: the owner's decision is needed" });
    expect(checks[0].check.summary).toContain('Linear is down');
    expect((await app.request('/approve/parlornights/CrookedDuke/e1', {}, env)).status).toBe(200);
  });
});

describe('workStart', () => {
  it('is the earliest of the PR creation and every commit date', async () => {
    commitDates = ['2026-10-08T13:00:00Z', '2026-10-07T08:00:00Z', 'not a date'];
    expect(await workStart(gh, event('w1'))).toEqual(new Date('2026-10-07T08:00:00Z'));
    commitDates = ['2026-10-09T00:00:00Z'];
    expect(await workStart(gh, event('w1'))).toEqual(new Date('2026-10-08T12:00:00Z'));
  });
});

describe('approval page', () => {
  it('is closed without the owner signing in through Access', async () => {
    owner = null;
    expect((await app.request('/approve/parlornights/CrookedDuke/a3', {}, env)).status).toBe(403);
    expect((await app.request('/github/setup', {}, env)).status).toBe(403);
  });

  it('shows the flagged hunks and turns the check green for that commit only', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('b1'));
    const page = await (await app.request('/approve/parlornights/CrookedDuke/b1', {}, env)).text();
    expect(page).toContain('src/__tests__/score.test.ts');
    expect(page).toContain('toBeGreaterThan(0)');

    const res = await decide('b1', 'decision=approve');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/approve/parlornights/CrookedDuke/b1?done=approved');
    const after = await (await app.request('/approve/parlornights/CrookedDuke/b1?done=approved', {}, env)).text();
    expect(after).toContain('Approved. The check is green for this commit.');
    expect(after).not.toContain('name="decision"');
    expect(checks.at(-1)).toMatchObject({ sha: 'b1', check: { conclusion: 'success', title: 'Approved by owner@example.com' } });

    await hook(event('b1', 'reopened'));
    expect(checks.at(-1)?.check).toMatchObject({ conclusion: 'success', title: 'Approved by owner@example.com' });
    expect(asked).toHaveLength(1);

    await hook(event('b2'));
    expect(checks.at(-1)).toMatchObject({ sha: 'b2', check: { conclusion: 'action_required' } });
  });

  it('keeps an approval made while a run for the same commit was in flight', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('race'));
    // The owner approves while a second run (say, a redelivered webhook) is still asking Jev.
    linear.ticketBefore.mockImplementation(async () => {
      await decide('race', 'decision=approve');
      return null;
    });
    await hook(event('race', 'reopened'));
    expect(checks.at(-1)).toMatchObject({ sha: 'race', check: { conclusion: 'success', title: 'Approved by owner@example.com' } });
  });

  it('rejects with the reason posted on the PR, and keeps the rejection on reruns of that commit', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('r1'));
    comments = [];
    expect((await decide('r1', 'decision=reject&reason=Keep+the+exact+total%3B+fix+the+scoring+instead.')).status).toBe(303);
    expect(checks.at(-1)).toMatchObject({ sha: 'r1', check: { conclusion: 'failure', title: 'Rejected by the owner: Keep the exact total; fix the scoring instead.' } });
    expect(comments).toEqual([{ pr: 42, body: expect.stringContaining('> Keep the exact total; fix the scoring instead.') }]);
    const after = await (await app.request('/approve/parlornights/CrookedDuke/r1?done=rejected', {}, env)).text();
    expect(after).toContain('Rejected. The check fails for this commit');
    expect(after).toContain('Keep the exact total; fix the scoring instead.');
    expect(after).not.toContain('name="decision"');

    // A second click (or a stale tab) does not change a decision already made.
    await decide('r1', 'decision=approve');
    expect(checks.at(-1)?.check.conclusion).toBe('failure');

    await hook(event('r1', 'reopened'));
    expect(checks.at(-1)?.check).toMatchObject({ conclusion: 'failure', title: expect.stringContaining('Rejected by the owner') });
    expect(asked).toHaveLength(1);
    expect((await decide('r1', 'decision=maybe')).status).toBe(400);
  });

  it('rejects without a reason too', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('r2'));
    await decide('r2', 'decision=reject');
    expect(checks.at(-1)?.check.title).toBe('Rejected by the owner');
  });

  it('still posts the check and records the run when the PR comment fails', async () => {
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
    expect(checks.at(-1)).toMatchObject({ sha: 'f1', check: { conclusion: 'action_required' } });
    expect((await app.request('/approve/parlornights/CrookedDuke/f1', {}, env)).status).toBe(200);
  });

  it('refuses a cross-site approval', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('c1'));
    expect((await app.request('/approve/parlornights/CrookedDuke/c1', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'decision=approve' }, env)).status).toBe(403);
  });
});

describe('GitHub App setup', () => {
  it('offers the manifest form and shows the new App secrets once', async () => {
    const setup = await (await app.request('/github/setup', {}, env)).text();
    expect(setup).toContain('https://github.com/organizations/parlornights/settings/apps/new');
    expect(setup).toContain('checks');
    const created = await (await app.request('/github/created?code=abc', {}, env)).text();
    expect(created).toContain('whsec');
    expect(created).toContain('https://github.com/apps/parlornights-moderator/installations/new');
  });
});

it('reads the issue id from the PR title', () => {
  expect(issueIdIn('CD-269: CI on wb')).toBe('CD-269');
  expect(issueIdIn('fix things')).toBeNull();
});
