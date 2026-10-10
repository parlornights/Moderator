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
  compare: async () => ({ files, commitDates }),
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

const event = (sha: string, action = 'synchronize', changed_files = files.length, base = 'main', pr = 42): PullRequestEvent => ({
  action,
  installation: { id: 1 },
  repository: { name: 'CrookedDuke', full_name: 'parlornights/CrookedDuke', owner: { login: 'parlornights' } },
  pull_request: { number: pr, title: 'CD-7: players rename games', head: { sha }, base: { sha: 'base-sha', ref: base }, user: { login: 'pr-author' }, created_at: '2026-10-08T12:00:00Z', changed_files },
});

async function hook(body: unknown, { signature = 'good', type = 'pull_request' } = {}) {
  const ctx = createExecutionContext();
  const res = await app.request('/github/webhook', { method: 'POST', headers: { 'X-Hub-Signature-256': signature, 'X-GitHub-Event': type }, body: JSON.stringify(body) }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const decide = (sha: string, form: string) =>
  app.request(`/approve/parlornights/CrookedDuke/42/${sha}`, { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }, env);

const changed: ChangedFile = { filename: 'src/__tests__/score.test.ts', status: 'modified', patch: '@@ -1 +1 @@\n-  expect(total).toBe(120);\n+  expect(total).toBeGreaterThan(0);' };

beforeEach(async () => {
  // Approvals carry across a PR's commits, so each test starts from an empty record.
  await env.DB.exec('DELETE FROM flags');
  await env.DB.exec('DELETE FROM approved_files');
  await env.DB.exec('DELETE FROM integrity');
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

  it('runs again when the PR base branch changes, and not on other edits', async () => {
    expect(await (await hook({ ...event('a1', 'edited'), changes: { title: { from: 'x' } } })).json()).toEqual({ ignored: true });
    expect((await hook({ ...event('a1', 'edited'), changes: { base: { ref: { from: 'b1' } } } })).status).toBe(202);
    expect(checks.at(-1)?.sha).toBe('a1');
  });

  it('is green without asking Jev when no existing test changed', async () => {
    files = [{ filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }, { filename: 'src/new.test.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x' }];
    expect((await hook(event('a2'))).status).toBe(202);
    expect(checks[0].check).toMatchObject({ title: 'Checking test changes' });
    expect(checks[0].check.conclusion).toBeUndefined();
    expect(checks.at(-1)).toEqual({ sha: 'a2', check: expect.objectContaining({ conclusion: 'success', title: 'No existing test changed', detailsUrl: 'https://moderator.parlornights.com/approve/parlornights/CrookedDuke/42/a2' }) });
    expect(asked).toEqual([]);
  });

  it('asks Jev with the ticket as it stood when the work began, and needs the owner when a hunk is unsanctioned', async () => {
    files = [changed];
    commitDates = ['2026-10-08T11:00:00Z', '2026-10-08T09:30:00Z'];
    answers = { h1: { noul: 0.1 } };
    await hook(event('a3'));
    expect(linear.ticketBefore).toHaveBeenCalledWith('CD-7', new Date('2026-10-08T09:30:00Z'));
    expect(asked[0].state.ticket).toMatchObject({ id: 'CD-7' });
    expect(checks.at(-1)!.check).toMatchObject({ conclusion: 'action_required', title: "1 test change(s) need the owner's decision" });
    expect(comments).toEqual([{ pr: 42, body: expect.stringContaining('@pr-author **test-integrity** on a3') }]);
    expect(comments[0].body).toContain('https://moderator.parlornights.com/approve/parlornights/CrookedDuke/42/a3');
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
    expect(checks.at(-1)!.check).toMatchObject({ conclusion: 'success', title: '1 test change(s), all sanctioned' });
    expect(comments).toEqual([]);
  });

  it('asks the question neutrally, with as many sanctioned samples as unsanctioned', async () => {
    files = [changed];
    answers = { h1: { noul: 0.9 } };
    await hook(event('n1'));
    const samples = asked[0].state.samples as { sanctioned: boolean }[];
    expect(samples.filter((x) => x.sanctioned).length).toBe(samples.filter((x) => !x.sanctioned).length);
  });

  it('never judges a new test file or a file that is not a test', async () => {
    files = [
      { filename: 'packages/new-lib/vitest.config.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+export default {};' },
      { filename: 'src/new.test.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+it()' },
      { filename: 'test/setup.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
    ];
    await hook(event('nf1'));
    expect(asked).toEqual([]);
    expect(checks.at(-1)?.check).toMatchObject({ conclusion: 'success', title: 'No existing test changed' });
  });

  it('judges every hunk of a large PR, in several Jev requests, untruncated', async () => {
    const long = `@@ -1 +1 @@\n-${'a'.repeat(5_000)}\n+${'b'.repeat(5_000)}`;
    files = Array.from({ length: 45 }, (_, n) => ({ filename: `src/__tests__/t${n}.test.ts`, status: 'modified', patch: long }));
    answers = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`h${n + 1}`, { noul: 0.9 }]));
    await hook(event('l1'));
    expect(asked.length).toBeGreaterThan(2);
    expect(asked.flatMap((a) => a.state.hunks).length).toBe(45);
    expect(asked[0].state.hunks[0].patch).toBe(long);
    expect(checks.at(-1)!.check).toMatchObject({ conclusion: 'success', title: '45 test change(s), all sanctioned' });
  });

  it('flags a hunk Jev gave no answer for', async () => {
    files = [changed, { ...changed, filename: 'src/__tests__/other.test.ts' }];
    answers = { h1: { noul: 0.9 } };
    await hook(event('m1'));
    expect(checks.at(-1)!.check).toMatchObject({ conclusion: 'action_required', title: "1 test change(s) need the owner's decision" });
  });

  it('needs the owner when Jev does not answer, and for a file GitHub shows no diff for', async () => {
    files = [changed];
    await hook(event('a5'));
    expect(checks.at(-1)!.check).toMatchObject({ conclusion: 'action_required', title: "Jev did not answer: the owner's decision is needed" });

    files = [{ filename: 'src/big.test.ts', status: 'modified' }];
    await hook(event('a6'));
    expect(asked).toHaveLength(1);
    expect(checks.at(-1)!.check).toMatchObject({ conclusion: 'action_required' });
  });

  it('needs the owner when GitHub lists fewer files than the PR changed', async () => {
    files = [{ filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }];
    await hook(event('p1', 'synchronize', 3500));
    expect(checks.at(-1)!.check).toMatchObject({ conclusion: 'action_required' });
    expect(checks.at(-1)!.check.summary).toContain('GitHub listed 1 of the PR\'s 3500 files');
  });

  it('carries nothing when reading the diff fails', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('g1'));
    await decide('g1', 'decision=approve');
    const compare = gh.compare;
    gh.compare = async () => {
      throw new Error('GitHub GraphQL refused the base blobs');
    };
    try {
      await hook(event('g2'));
    } finally {
      gh.compare = compare;
    }
    expect(checks.at(-1)).toMatchObject({ sha: 'g2', check: { conclusion: 'action_required', title: "The check errored: the owner's decision is needed" } });
  });

  it('leaves a red check and a decidable row when the run throws', async () => {
    files = [changed];
    linear.ticketBefore.mockRejectedValue(new Error('Linear is down'));
    await hook(event('e1'));
    expect(checks.at(-1)!.check).toMatchObject({ conclusion: 'action_required', title: "The check errored: the owner's decision is needed" });
    expect(checks.at(-1)!.check.summary).toContain('Linear is down');
    expect((await app.request('/approve/parlornights/CrookedDuke/42/e1', {}, env)).status).toBe(200);
  });
});

describe('decisions belong to one PR and base', () => {
  it('judges again when the same commit heads another PR or the base branch changed', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('s1'));
    await decide('s1', 'decision=approve');
    expect(checks.at(-1)?.check.conclusion).toBe('success');

    await hook(event('s1', 'opened', 1, 'main', 43));
    expect(checks.at(-1)?.check.conclusion).toBe('action_required');

    await hook(event('s1', 'edited', 1, 'release'));
    expect(checks.at(-1)?.check.conclusion).toBe('action_required');
  });

  it("carries an approval to a push that leaves the PR's own diff unchanged, and not to one that changes it", async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('m1'));
    await decide('m1', 'decision=approve');

    // Mergify merges main into the PR: new head, same PR diff.
    await hook(event('m2'));
    expect(checks.at(-1)).toMatchObject({ sha: 'm2', check: { conclusion: 'success', title: 'Approved by owner@example.com', summary: expect.stringContaining('Carried from m1') } });
    expect(asked).toHaveLength(1);

    // The agent then changes another file of its own diff: the approved test file is as it was, so it stays approved
    // (owner, Q48 A); the whole-diff carry no longer applies.
    files = [changed, { filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }];
    await hook(event('m3'));
    expect(checks.at(-1)).toMatchObject({ sha: 'm3', check: { conclusion: 'success', title: expect.stringContaining('approved earlier') } });

    // Not carried to another base branch either.
    files = [changed];
    await hook(event('m4', 'synchronize', 1, 'release'));
    expect(checks.at(-1)).toMatchObject({ sha: 'm4', check: { conclusion: 'action_required' } });
  });

  it('carries an approval for each test file left exactly as approved, while other files of the PR change (owner, Q48 A)', async () => {
    const other: ChangedFile = { filename: 'src/rules.spec.ts', status: 'modified', patch: '@@ -3 +3 @@\n-  expect(rules).toHaveLength(4);\n+  expect(rules.length).toBeGreaterThan(0);' };
    const sanctioned: ChangedFile = { filename: 'src/names.test.ts', status: 'modified', patch: '@@ -9 +9 @@\n-  expect(valid(a24)).toBe(true);\n+  expect(valid(a32)).toBe(true);' };
    files = [changed, other, sanctioned];
    answers = { h1: { noul: 0.1 }, h2: { noul: 0.2 }, h3: { noul: 0.9 } };
    await hook(event('q1'));
    await decide('q1', 'decision=approve');

    // A commit that adds baseline images: the approved test files are as they were, so the owner is not asked again.
    files = [changed, other, sanctioned, { filename: 'e2e/baseline/home.png', status: 'added', sha: 'blob1' }];
    answers = { h1: { noul: 0.9 } };
    await hook(event('q2'));
    expect(checks.at(-1)).toMatchObject({ sha: 'q2', check: { conclusion: 'success', title: expect.stringContaining('2 approved earlier by owner@example.com and unchanged since') } });
    expect(asked.at(-1)?.state.hunks.map((h: { file: string }) => h.file)).toEqual(['src/names.test.ts']);

    // One approved file changes again: it is asked again; the untouched one stays approved.
    files = [{ ...changed, patch: '@@ -1 +1 @@\n-  expect(total).toBe(120);\n+  expect(total).toBeDefined();' }, other, sanctioned];
    answers = { h1: { noul: 0.1 } };
    await hook(event('q3'));
    expect(checks.at(-1)).toMatchObject({ sha: 'q3', check: { conclusion: 'action_required' } });
    expect(checks.at(-1)?.check.summary).toContain('score.test.ts');
    expect(checks.at(-1)?.check.summary).not.toContain('rules.spec.ts');

    // Not on another base branch.
    files = [changed, other, sanctioned];
    await hook(event('q4', 'synchronize', 3, 'release'));
    expect(checks.at(-1)).toMatchObject({ sha: 'q4', check: { conclusion: 'action_required' } });
  });

  it('carries an approval of a test file GitHub sends no patch for while it stays as approved, and asks again when it changes', async () => {
    // A pure rename: GitHub sends no patch, only the blob sha.
    const renamed: ChangedFile = { filename: 'infra/session/__tests__/sandbox-net.test.mjs', previousFilename: 'infra/sandbox-net.test.mjs', status: 'renamed', sha: 'blob1', baseSha: 'blob1' };
    files = [renamed];
    await hook(event('n1'));
    expect(checks.at(-1)).toMatchObject({ sha: 'n1', check: { conclusion: 'action_required', summary: expect.stringContaining('no diff') } });
    expect(asked).toHaveLength(0);
    await decide('n1', 'decision=approve');

    // The base branch is merged in and the PR's own diff changes elsewhere: the renamed file is as approved.
    files = [renamed, { filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }];
    await hook(event('n2'));
    expect(checks.at(-1)).toMatchObject({ sha: 'n2', check: { conclusion: 'success', title: expect.stringContaining('1 approved earlier by owner@example.com and unchanged since (infra/session/__tests__/sandbox-net.test.mjs)') } });

    // Its content changes (another blob sha): flagged again.
    files = [{ ...renamed, sha: 'blob2' }, { filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }];
    await hook(event('n3'));
    expect(checks.at(-1)).toMatchObject({ sha: 'n3', check: { conclusion: 'action_required', summary: expect.stringContaining('sandbox-net.test.mjs') } });

    // So does another previous name.
    files = [{ ...renamed, previousFilename: 'infra/net.test.mjs' }, { filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }];
    await hook(event('n4'));
    expect(checks.at(-1)).toMatchObject({ sha: 'n4', check: { conclusion: 'action_required' } });
    expect(asked).toHaveLength(0);
  });

  it('asks again about an approved file with no patch when its blob at the merge base changes, though its head blob is the same', async () => {
    // Too large for a patch. The PR keeps its own version (big2) of a file main later changes (big1 -> big3).
    const big: ChangedFile = { filename: 'e2e/fixtures.e2e.ts', status: 'modified', sha: 'big2', baseSha: 'big1' };
    const app: ChangedFile = { filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' };
    files = [big];
    await hook(event('v1'));
    await decide('v1', 'decision=approve');

    // Unchanged: the whole-diff carry, then the per-file carry.
    await hook(event('v2'));
    expect(checks.at(-1)).toMatchObject({ sha: 'v2', check: { conclusion: 'success', summary: expect.stringContaining('Carried from v1') } });
    files = [big, app];
    await hook(event('v3'));
    expect(checks.at(-1)).toMatchObject({ sha: 'v3', check: { conclusion: 'success', title: expect.stringContaining('approved earlier') } });

    // Main's change is merged in and reverted by the PR: neither carry applies.
    files = [{ ...big, baseSha: 'big3' }];
    await hook(event('v4'));
    expect(checks.at(-1)).toMatchObject({ sha: 'v4', check: { conclusion: 'action_required', summary: expect.stringContaining('fixtures.e2e.ts') } });
    files = [{ ...big, baseSha: 'big3' }, app];
    await hook(event('v5'));
    expect(checks.at(-1)).toMatchObject({ sha: 'v5', check: { conclusion: 'action_required', summary: expect.stringContaining('fixtures.e2e.ts') } });

    // Gone from the merge base reads differently from any blob.
    files = [{ ...big, baseSha: null }, app];
    await hook(event('v6'));
    expect(checks.at(-1)).toMatchObject({ sha: 'v6', check: { conclusion: 'action_required' } });
  });

  it('never carries an approval of a file with no patch and no head blob sha', async () => {
    const blind: ChangedFile = { filename: 'e2e/fixtures.e2e.ts', status: 'modified', baseSha: 'big1' };
    files = [blind];
    await hook(event('u1'));
    await decide('u1', 'decision=approve');
    files = [blind, { filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }];
    await hook(event('u2'));
    expect(checks.at(-1)).toMatchObject({ sha: 'u2', check: { conclusion: 'action_required', summary: expect.stringContaining('fixtures.e2e.ts') } });
    // Nor over the whole PR's diff, which says nothing about its content either.
    files = [blind];
    await hook(event('u2b'));
    expect(checks.at(-1)).toMatchObject({ sha: 'u2b', check: { conclusion: 'action_required', summary: expect.stringContaining('fixtures.e2e.ts') } });

    // A removed file is known by its blob at the merge base.
    const removed: ChangedFile = { filename: 'e2e/old.e2e.ts', status: 'removed', baseSha: 'old1' };
    files = [removed];
    await hook(event('u3'));
    await decide('u3', 'decision=approve');
    files = [removed, { filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }];
    await hook(event('u4'));
    expect(checks.at(-1)).toMatchObject({ sha: 'u4', check: { conclusion: 'success', title: expect.stringContaining('approved earlier') } });
  });

  it('keeps a flagged hunk flagged on later commits of the PR without asking Jev again', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('k1'));
    answers = { h1: { noul: 0.99 } };
    await hook(event('k2'));
    expect(asked).toHaveLength(1);
    expect(checks.at(-1)?.check).toMatchObject({ conclusion: 'action_required' });
    expect(checks.at(-1)?.check.summary).toContain('Flagged on an earlier commit');
  });

  it('keeps a decision made after the run saved but before it posted', async () => {
    files = [changed];
    answers = { h1: { noul: 0.9 } };
    await hook(event('q0'));
    const setCheck = gh.setCheck;
    let once = false;
    gh.setCheck = async (...args) => {
      if (!once && args[4].conclusion === 'success' && args[3] === 'q1') {
        once = true;
        await decide('q1', 'decision=reject');
      }
      return setCheck(...args);
    };
    try {
      await hook(event('q1'));
    } finally {
      gh.setCheck = setCheck;
    }
    await hook(event('q1', 'reopened'));
    expect(checks.at(-1)).toMatchObject({ sha: 'q1', check: { conclusion: 'failure' } });
  });
});

describe('PR comments ping the owner once per set of pending findings', () => {
  const work: ChangedFile = { filename: '.work/notes.md', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' };

  it('posts one comment and two check runs for two pushes with the same pending findings', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('p1'));
    files = [changed, work];
    await hook(event('p2'));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('on p1');
    const failed = checks.filter((c) => c.check.conclusion === 'action_required');
    expect(failed.map((c) => c.sha)).toEqual(['p1', 'p2']);
    expect(failed[1].check).toMatchObject({ title: "1 test change(s) need the owner's decision", detailsUrl: 'https://moderator.parlornights.com/approve/parlornights/CrookedDuke/42/p2' });
  });

  it('comments again, saying what changed, when a push adds a flagged hunk', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('p3'));
    const other: ChangedFile = { filename: 'src/rules.spec.ts', status: 'modified', patch: '@@ -3 +3 @@\n-  expect(rules).toHaveLength(4);\n+  expect(rules.length).toBeGreaterThan(0);' };
    files = [changed, other];
    await hook(event('p4'));
    expect(comments).toHaveLength(2);
    expect(comments[1].body).toContain('@pr-author **test-integrity** on p4');
    expect(comments[1].body).toContain('Changed since p3: 1 new or changed (`src/rules.spec.ts`)');
    expect(comments[1].body).toContain('https://moderator.parlornights.com/approve/parlornights/CrookedDuke/42/p4');
    // Then the same set again: quiet.
    await hook(event('p5'));
    expect(comments).toHaveLength(2);
    expect(checks.at(-1)).toMatchObject({ sha: 'p5', check: { conclusion: 'action_required' } });
  });

  it('comments as before on a push after an approval', async () => {
    const blind: ChangedFile = { filename: 'e2e/fixtures.e2e.ts', status: 'modified', baseSha: 'big1' };
    files = [blind];
    await hook(event('p6'));
    await decide('p6', 'decision=approve');
    // Never carried, so asked again with the same findings: the approval came between, so the owner is pinged.
    files = [blind, work];
    await hook(event('p7'));
    expect(comments).toHaveLength(2);
    expect(comments[1].body).toContain('on p7');
    expect(comments[1].body).not.toContain('Changed since');
    expect(checks.at(-1)).toMatchObject({ sha: 'p7', check: { conclusion: 'action_required' } });
  });
});

describe('workStart', () => {
  it('is the earliest of the PR creation and every commit date', () => {
    expect(workStart(event('w1'), ['2026-10-08T13:00:00Z', '2026-10-07T08:00:00Z', 'not a date'])).toEqual(new Date('2026-10-07T08:00:00Z'));
    expect(workStart(event('w1'), ['2026-10-09T00:00:00Z'])).toEqual(new Date('2026-10-08T12:00:00Z'));
  });
});

describe('approval page', () => {
  it('is closed without the owner signing in through Access', async () => {
    owner = null;
    expect((await app.request('/approve/parlornights/CrookedDuke/42/a3', {}, env)).status).toBe(403);
    expect((await app.request('/github/setup', {}, env)).status).toBe(403);
  });

  it('shows the flagged hunks and turns the check green for that commit', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('b1'));
    const page = await (await app.request('/approve/parlornights/CrookedDuke/42/b1', {}, env)).text();
    expect(page).toContain('src/__tests__/score.test.ts');
    expect(page).toContain('toBeGreaterThan(0)');

    const res = await decide('b1', 'decision=approve');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/approve/parlornights/CrookedDuke/42/b1?done=approved');
    const after = await (await app.request('/approve/parlornights/CrookedDuke/42/b1?done=approved', {}, env)).text();
    expect(after).toContain('Approved. The check is green for this commit.');
    expect(after).not.toContain('name="decision"');
    expect(checks.at(-1)).toMatchObject({ sha: 'b1', check: { conclusion: 'success', title: 'Approved by owner@example.com' } });

    await hook(event('b1', 'reopened'));
    expect(checks.at(-1)?.check).toMatchObject({ conclusion: 'success', title: 'Approved by owner@example.com' });
    expect(asked).toHaveLength(1);

    // A new commit that changes the approved test file needs a new decision.
    files = [{ ...changed, patch: '@@ -1 +1 @@\n-  expect(total).toBe(120);\n+  expect(total).toBeTruthy();' }];
    await hook(event('b2'));
    expect(checks.at(-1)).toMatchObject({ sha: 'b2', check: { conclusion: 'action_required' } });
  });

  it('keeps an approval made while a run for the same commit was in flight', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('race'));
    // The owner approves while a second run (say, a redelivered webhook) is still reading the ticket.
    await env.DB.exec('DELETE FROM flags');
  await env.DB.exec('DELETE FROM approved_files');
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
    const after = await (await app.request('/approve/parlornights/CrookedDuke/42/r1?done=rejected', {}, env)).text();
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
    expect((await app.request('/approve/parlornights/CrookedDuke/42/f1', {}, env)).status).toBe(200);
  });

  it('refuses a cross-site approval', async () => {
    files = [changed];
    answers = { h1: { noul: 0.1 } };
    await hook(event('c1'));
    expect((await app.request('/approve/parlornights/CrookedDuke/42/c1', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'decision=approve' }, env)).status).toBe(403);
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

it('reads the issue id the PR title starts with', () => {
  expect(issueIdIn('CD-269: CI on wb')).toBe('CD-269');
  expect(issueIdIn('UTF-8 fix for CD-7')).toBeNull();
  expect(issueIdIn('  PAR-27: x')).toBe('PAR-27');
  expect(issueIdIn('fix things')).toBeNull();
});
