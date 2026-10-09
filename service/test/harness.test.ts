import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { isDirect, pushHarness, type Branches } from '../src/harness';

const SHA = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const CONFIG = JSON.stringify({ issuePattern: 'x', directToMain: ['.claude/', 'CLAUDE.md', 'docs/papercuts.md', 'harness/'] });

let config: string | null;
let cmp: { status: string; paths: string[]; complete: boolean };
const b = { tip: vi.fn(), file: vi.fn(), compare: vi.fn(), move: vi.fn(), remove: vi.fn() } satisfies Branches;

beforeEach(() => {
  vi.resetAllMocks();
  config = CONFIG;
  cmp = { status: 'ahead', paths: ['.claude/skills/x/SKILL.md', 'CLAUDE.md'], complete: true };
  b.tip.mockResolvedValue({ installation: 7, branch: 'main', sha: TIP });
  b.file.mockImplementation(async () => config);
  b.compare.mockImplementation(async () => cmp);
  b.move.mockResolvedValue(true);
  b.remove.mockResolvedValue(undefined);
});

const push = (body: Partial<{ repo: string; sha: string; branch: string }> = {}) => pushHarness(b, { repo: 'o/r', sha: SHA, branch: 'harness/aaaaaaa', ...body });

describe('pushHarness', () => {
  it('moves the default branch as a fast-forward when every path is direct, and deletes the scratch branch', async () => {
    expect(await push()).toEqual({ status: 200, body: { outcome: 'done', branch: 'main', sha: SHA, paths: ['.claude/skills/x/SKILL.md', 'CLAUDE.md'] } });
    expect(b.file).toHaveBeenCalledWith(7, 'o', 'r', 'moderator.config.json', TIP);
    expect(b.compare).toHaveBeenCalledWith(7, 'o', 'r', TIP, SHA);
    expect(b.move).toHaveBeenCalledWith(7, 'o', 'r', 'main', SHA);
    expect(b.remove).toHaveBeenCalledWith(7, 'o', 'r', 'harness/aaaaaaa');
  });

  it('still answers done when the scratch branch cannot be deleted, and deletes nothing without one', async () => {
    b.remove.mockRejectedValue(new Error('gone'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await push()).status).toBe(200);
    expect(log).toHaveBeenCalled();
    b.remove.mockClear();
    expect((await pushHarness(b, { repo: 'o/r', sha: SHA })).status).toBe(200);
    expect(b.remove).not.toHaveBeenCalled();
  });

  it('refuses a path outside directToMain, a rename from outside included, and lists them', async () => {
    cmp = { status: 'ahead', paths: ['CLAUDE.md', 'src/app.ts', '.claude/moved.md', 'packages/game/old.md'], complete: true };
    expect(await push()).toEqual({ status: 403, body: { outcome: 'refused', reason: "outside main's directToMain paths: these need a pull request", paths: ['src/app.ts', 'packages/game/old.md'] } });
    expect(b.move).not.toHaveBeenCalled();
    expect(b.remove).not.toHaveBeenCalled();
  });

  it('refuses when the default branch has no config or its config lists no directToMain', async () => {
    for (const c of [null, JSON.stringify({ issuePattern: 'x' }), JSON.stringify({ directToMain: [] })]) {
      config = c;
      expect(await push()).toEqual({ status: 403, body: { outcome: 'refused', reason: "main's moderator.config.json lists no directToMain paths" } });
    }
    expect(b.compare).not.toHaveBeenCalled();
    expect(b.move).not.toHaveBeenCalled();
  });

  it('refuses anything that is not ahead of the default branch: diverged, behind, identical', async () => {
    for (const status of ['diverged', 'behind']) {
      cmp = { status, paths: ['CLAUDE.md'], complete: true };
      expect(await push()).toEqual({ status: 409, body: { outcome: 'refused', reason: `aaaaaaa is not a fast-forward of main (${status}): merge origin/main into it and push again` } });
    }
    cmp = { status: 'identical', paths: [], complete: true };
    expect(await push()).toEqual({ status: 409, body: { outcome: 'refused', reason: "aaaaaaa is already main's tip" } });
    expect(b.move).not.toHaveBeenCalled();
  });

  it('refuses when GitHub did not list every changed file', async () => {
    cmp = { status: 'ahead', paths: ['CLAUDE.md'], complete: false };
    expect(await push()).toMatchObject({ status: 422, body: { outcome: 'refused', reason: expect.stringMatching(/did not list every changed file/) } });
    expect(b.move).not.toHaveBeenCalled();
  });

  it('answers 409 when the default branch moved meanwhile, and keeps the scratch branch', async () => {
    b.move.mockResolvedValue(false);
    expect(await push()).toEqual({ status: 409, body: { outcome: 'refused', reason: 'main moved meanwhile: merge origin/main and push again' } });
    expect(b.remove).not.toHaveBeenCalled();
  });

  it("refuses when Moderator's App is not installed, and a scratch branch that is the default branch", async () => {
    b.tip.mockResolvedValueOnce(null);
    expect(await push()).toEqual({ status: 404, body: { outcome: 'refused', reason: "Moderator's GitHub App is not installed on o/r" } });
    expect(await push({ branch: 'main' })).toEqual({ status: 422, body: { outcome: 'refused', reason: 'the scratch branch cannot be main itself' } });
    expect(b.move).not.toHaveBeenCalled();
    expect(b.remove).not.toHaveBeenCalled();
  });
});

describe('isDirect', () => {
  it('takes a folder entry for everything under it, a file entry for that file only, and no lookalike prefix', () => {
    const direct = ['.claude/', 'CLAUDE.md'];
    expect(isDirect('.claude/settings.json', direct)).toBe(true);
    expect(isDirect('.claude/skills/a/SKILL.md', direct)).toBe(true);
    expect(isDirect('CLAUDE.md', direct)).toBe(true);
    expect(isDirect('.claude', direct)).toBe(false);
    expect(isDirect('.claudex/x.md', direct)).toBe(false);
    expect(isDirect('CLAUDE.md.bak', direct)).toBe(false);
    expect(isDirect('docs/CLAUDE.md', direct)).toBe(false);
  });
});

describe('POST /tool/harness/push', () => {
  const unused = () => {
    throw new Error('not used here');
  };
  const app = createApp({ jev: unused, linear: unused, github: unused, access: () => async () => null, convertManifest: unused, branches: () => b });
  const call = (json: unknown, key: string | null = 'key-one') =>
    app.request('/tool/harness/push', { method: 'POST', headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(json) }, env);
  const rows = async () =>
    (await (await app.request('/audit', { headers: { Authorization: 'Bearer key-one' } }, env)).json()) as { action: string; outcome: string; input: unknown; response: unknown }[];

  it('refuses a call without a key, and a bad body, before touching GitHub', async () => {
    expect((await call({ repo: 'o/r', sha: SHA }, null)).status).toBe(401);
    expect((await call({ repo: 'o/r', sha: SHA }, 'nope')).status).toBe(401);
    for (const body of [{ repo: 'o', sha: SHA }, { repo: 'o/r', sha: 'abc1234' }, { repo: 'o/r', sha: SHA, branch: '' }]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty('error');
    }
    expect(b.tip).not.toHaveBeenCalled();
  });

  it('answers with the outcome and its status, and writes one audit row per call', async () => {
    const before = (await rows()).length;
    const done = await call({ repo: 'o/r', sha: SHA, branch: 'harness/aaaaaaa' });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ outcome: 'done', branch: 'main', sha: SHA });
    cmp = { status: 'ahead', paths: ['src/x.ts'], complete: true };
    const out = await call({ repo: 'o/r', sha: SHA, branch: 'harness/aaaaaaa' });
    expect(out.status).toBe(403);
    expect(await out.json()).toMatchObject({ outcome: 'refused', paths: ['src/x.ts'] });
    b.tip.mockRejectedValueOnce(new Error('GitHub is down'));
    expect((await call({ repo: 'o/r', sha: SHA })).status).toBe(502);
    const after = await rows();
    expect(after.length - before).toBe(3);
    expect(after.slice(0, 3).map((r) => [r.action, r.outcome])).toEqual([
      ['harness/push', 'error'],
      ['harness/push', 'refused'],
      ['harness/push', 'done'],
    ]);
    expect(after[1]).toMatchObject({ input: { repo: 'o/r', sha: SHA, branch: 'harness/aaaaaaa' }, response: { outcome: 'refused', paths: ['src/x.ts'] } });
  });

  it('answers 501 when the service has no way to move branches', async () => {
    const bare = createApp({ jev: unused, linear: unused, github: unused, access: () => async () => null, convertManifest: unused });
    const res = await bare.request('/tool/harness/push', { method: 'POST', headers: { Authorization: 'Bearer key-one', 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: 'o/r', sha: SHA }) }, env);
    expect(res.status).toBe(501);
  });
});
