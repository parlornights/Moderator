// Live smoke test of the deployed Worker, against real Jev and Linear. It files one issue, marked as a test, and
// cancels it at the end. Run: MODERATOR_KEY=<key> LINEAR_TEAM=<key> pnpm smoke
import { describe, expect, it } from 'vitest';

const base = process.env.MODERATOR_URL ?? 'https://moderator.parlornights.com';
const key = process.env.MODERATOR_KEY;
const team = process.env.LINEAR_TEAM ?? 'PAR';

const call = async (method: string, path: string, body?: unknown, auth = `Bearer ${key}`) => {
  const res = await fetch(base + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
};

describe.runIf(key)('Moderator live', { timeout: 30_000 }, () => {
  it('refuses a wrong key', async () => {
    expect((await call('GET', '/audit', undefined, 'Bearer nope')).status).toBe(401);
  });

  it('runs every Jev check', async () => {
    const inputs: Record<string, unknown> = {
      pick: { issue: 'X-1', brief: 'Rename the Settings "Sign out" button to "Log out" and update its test.' },
      reviewer: { files: ['src/auth/session.ts'], numstat: ['120\t30\tsrc/auth/session.ts'], commits: ['auth: rotate sessions'] },
      verdict: { criteria: ['A name longer than 24 characters is refused on save'], diff: "if (name.length > 24) return error('tooLong')\nexpect(save('x'.repeat(25))).toEqual(error('tooLong'))" },
      'open-questions': { open_questions: '', last_message: '#42 merged; tests are re-running.' },
      'needs-decision': { escalation: 'keep the 20-character cap or allow 24? | options: A 20 / B 24 | recommend: B because the board shows 24' },
      'linear-issue': { title: 'Players can rename a saved game', description: 'Done when the new name survives a reload.' },
      'linear-text': { text: 'Done when the new name survives a reload.' },
      'linear-comment': { body: 'Merged in #42: players can rename saved games.' },
    };
    for (const [check, input] of Object.entries(inputs)) {
      const r = await call('POST', `/tool/jev/${check}`, input);
      expect(r, check).toMatchObject({ status: 200, body: { outcome: 'done' } });
    }
  });

  it('files, updates and comments on a Linear issue behind Jev, then cancels it', async () => {
    expect((await call('POST', '/tool/linear/issue', { team, title: 'Fix the stop hook regex', description: 'The harness hook misses a heading.' })).body).toMatchObject({ outcome: 'ask_owner' });

    const created = await call('POST', '/tool/linear/issue', {
      team,
      title: '[Moderator smoke test] Players can rename a saved game',
      description: 'From the game list a player renames a saved game. Done when the new name shows in the list and survives a reload.\n\n(Moderator smoke test; canceled at the end.)',
    });
    expect(created.body).toMatchObject({ outcome: 'done', id: expect.stringMatching(new RegExp(`^${team}-`)) });
    const id = created.body.id as string;

    expect((await call('PATCH', `/tool/linear/issue/${id}`, { priority: 3, addLabels: ['Feature'], links: [{ url: 'https://example.com/smoke', title: 'Smoke link' }] })).body).toMatchObject({ outcome: 'done' });
    expect((await call('PATCH', `/tool/linear/issue/${id}`, { removeLabels: ['Feature'] })).body).toMatchObject({ outcome: 'done' });
    expect((await call('PATCH', `/tool/linear/issue/${id}`, { description: 'Gate GREEN at tree 3f2a, oxlint passed.' })).body).toMatchObject({ outcome: 'ask_owner' });
    expect((await call('POST', '/tool/linear/comment', { issue: id, body: 'Working on it, tests are running.' })).body).toMatchObject({ outcome: 'ask_owner' });
    expect((await call('POST', '/tool/linear/comment', { issue: id, body: 'Owner decided: renaming happens from the game list only, because that is where saved games are managed.' })).body).toMatchObject({ outcome: 'done' });
    expect((await call('PATCH', `/tool/linear/issue/${id}`, { status: 'Canceled' })).body).toMatchObject({ outcome: 'done' });

    const audit = await call('GET', '/audit?limit=5');
    expect(audit.body[0]).toMatchObject({ action: 'linear/issue.update', outcome: 'done', input: { id, status: 'Canceled' } });
  });
});
