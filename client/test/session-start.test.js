// Session start: the role first, then the orient block that names the handoff note by path, then the issue, the
// repo's start docs and the papercut log; all under Claude Code's hook cap.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { CONFIG, cli, env, fakeGh, hook, repo } from './helpers.js';

const { fitSessionContext } = await import('../src/orient.js');
const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const ROLE = fs.readFileSync(new URL('../role.md', import.meta.url), 'utf8').trim();

const start = async (dir, source = 'startup', extra = {}) => (await hook('session-start', { source, session_id: 's1', ...extra }, { cwd: dir })).json;
const ctx = async (...args) => (await start(...args)).hookSpecificOutput.additionalContext;

test('the role comes first on every source, then orient, then the Linear line outside a compaction', async () => {
  const r = repo({ branch: 'cd-1-x' });
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const text = await ctx(r.dir, source);
    assert.ok(text.startsWith(ROLE), source);
    assert.match(text, /orient: branch cd-1-x .* issue CD-1/, source);
    assert[source === 'compact' ? 'doesNotMatch' : 'match'](text, /Linear: read CD-1 first/, source);
  }
  assert.ok(ROLE.length < 4000, 'the role leaves room for the orient block under the cap');
});

test('the handoff note is named by path and never inlined; without one, the block says so', async () => {
  const r = repo({ branch: 'cd-2-x' });
  assert.match(await ctx(r.dir), /No handoff note yet/);
  r.put('.work/CD-2/handoff.md', 'status: in-progress\n\n## Goal\n\nSECRET-GOAL-TEXT\n');
  const text = await ctx(r.dir);
  assert.match(text, /Handoff: read \.work\/CD-2\/handoff\.md in full now, before anything else/);
  assert.ok(text.indexOf('Handoff: read') < text.indexOf('orient: branch'), 'the pointer leads, so a cut at the cap never drops it');
  assert.doesNotMatch(text, /SECRET-GOAL-TEXT/);
});

test("a compaction refreshes the note's auto block first, so the new context reads the turns just summarized", async () => {
  const r = repo({ branch: 'cd-3-x' });
  r.put('t.jsonl', JSON.stringify({ type: 'user', message: { content: 'the turn before compaction' } }) + '\n');
  await start(r.dir, 'compact', { transcript_path: `${r.dir}/t.jsonl` });
  assert.match(r.read('.work/CD-3/handoff.md'), /U: the turn before compaction/);
});

test('the start docs that exist are named, each with why; the papercut log is counted, open and consolidated', async () => {
  const r = repo({
    branch: 'cd-4-x',
    config: { ...CONFIG, papercuts: 'notes/cuts.md', readAtStart: [{ path: 'docs/MAP.md', why: 'the map' }, { path: 'docs/TESTING.md', why: 'how tests are written' }] },
  });
  assert.doesNotMatch(await ctx(r.dir), /Docs:|Papercuts:/);
  r.put('docs/TESTING.md', '#');
  assert.match(await ctx(r.dir), /Docs: read docs\/TESTING\.md in full now, right after CLAUDE\.md\. how tests are written\./);
  r.put('docs/MAP.md', '#');
  assert.match(await ctx(r.dir), /Docs: read docs\/MAP\.md and docs\/TESTING\.md in full now, right after CLAUDE\.md\. the map; how tests are written\./);
  r.put('notes/cuts.md', '# Papercuts\n\n- a bullet is not an entry\n\n## Unconsolidated\n\n- 2026-10-07 | CD-1 | protocol | open one\n\n## Consolidated 2026-10-01\n\n- 2026-09-30 | CD-2 | gate | old one\n');
  const text = await ctx(r.dir);
  assert.match(text, /Papercuts: read notes\/cuts\.md in full now \(2 entries/);
  assert.doesNotMatch(text, /open one|old one/);
});

test('an unreadable log costs neither the orient block nor the start', async () => {
  const r = repo({ branch: 'cd-5-x' });
  fs.mkdirSync(`${r.dir}/docs/papercuts.md`, { recursive: true });
  const text = await ctx(r.dir);
  assert.match(text, /orient:/);
  assert.doesNotMatch(text, /Papercuts:/);
});

test('a session is titled by its issue on startup; outside a task branch there is no title and no events', async () => {
  const r = repo({ branch: 'cd-6-x' });
  assert.equal((await start(r.dir)).hookSpecificOutput.sessionTitle, 'CD-6');
  assert.equal((await start(r.dir, 'startup', { session_title: 'mine' })).hookSpecificOutput.sessionTitle, undefined);
  const plain = repo({ branch: 'main' });
  const out = await start(plain.dir);
  assert.equal(out.hookSpecificOutput.sessionTitle, undefined);
  assert.equal(fs.existsSync(`${plain.dir}/.work`), false);
});

test('the context stays under the hook cap: the orient block is cut, the role and the tail lines are kept', () => {
  const head = 'H'.repeat(3000);
  const tail = 'Papercuts: read docs/papercuts.md in full now (69 entries).';
  const fitted = fitSessionContext({ head, middle: 'm'.repeat(12000), tail });
  assert.ok(fitted.length <= 9500, String(fitted.length));
  assert.ok(fitted.startsWith(head));
  assert.ok(fitted.endsWith(tail));
  assert.match(fitted, /orient cut to fit/);
  assert.equal(fitSessionContext({ head: 'a', middle: 'b', tail: 'c' }), 'a\n\nb\n\nc');
});

test("orient finds the branch's open PR over GitHub's REST API, and says unknown, never none, when it cannot ask", async () => {
  const r = repo({ branch: 'claude/fix-thing' });
  r.git('remote', 'add', 'origin', 'https://github.com/acme/app');
  const gh = fakeGh(r.scratch, {
    'repos/acme/app/pulls?state=open&head=acme%3Aclaude%2Ffix-thing': [{ number: 12, title: 'CD-12: fix the thing', html_url: 'https://github.com/acme/app/pull/12', draft: false }],
    'repos/acme/app/pulls/12': { mergeable_state: 'clean' },
  });
  const found = await cli(['orient'], { cwd: r.dir, env: gh });
  assert.match(found.stdout, /PR for this branch: #12 open clean https:\/\/github\.com\/acme\/app\/pull\/12 "CD-12: fix the thing"/);
  const none = await cli(['orient'], { cwd: r.dir, env: fakeGh(r.scratch, { 'repos/acme/app/pulls?state=open&head=acme%3Aclaude%2Ffix-thing': [] }) });
  assert.match(none.stdout, /PR for this branch: none for this branch/);
  const two = [1, 2].map((number) => ({ number, title: 't', html_url: 'u', draft: false }));
  const several = await cli(['orient'], { cwd: r.dir, env: fakeGh(r.scratch, { 'repos/acme/app/pulls?state=open&head=acme%3Aclaude%2Ffix-thing': two }) });
  assert.match(several.stdout, /PR for this branch: unknown \(several open PRs for the branch: #1, #2\)/);
  const down = await cli(['orient'], { cwd: r.dir, env: fakeGh(r.scratch, {}) });
  assert.match(down.stdout, /PR for this branch: unknown \(gh: Not Found \(HTTP 404\)\)/);
});

test("a session on a branch that names no issue takes its PR's, so the ledger starts under that issue", async () => {
  const r = repo({ branch: 'claude/fix-thing' });
  r.git('remote', 'add', 'origin', 'https://github.com/acme/app');
  const gh = fakeGh(r.scratch, { 'repos/acme/app/pulls?state=open&head=acme%3Aclaude%2Ffix-thing': [{ number: 12, title: 'CD-12: fix', html_url: 'u', draft: false }] });
  const out = (await hook('session-start', { source: 'startup', session_id: 's1' }, { cwd: r.dir, env: gh })).json;
  assert.match(out.hookSpecificOutput.additionalContext, /issue CD-12/);
  assert.deepEqual(fs.readdirSync(`${r.dir}/.work`), ['CD-12']);
});

test("orient lists only this session's units started within a day, and a session start prunes the rest", async () => {
  const r = repo({ branch: 'cd-8-x' });
  const now = new Date().toISOString();
  r.put(
    '.work/CD-8/running.json',
    JSON.stringify({
      mine111: { agent_type: 'unit', started: now, session: 's1' },
      other22: { agent_type: 'unit', started: now, session: 's0' },
      stale333: { agent_type: 'unit', started: new Date(Date.now() - 25 * 3600_000).toISOString(), session: 's1' },
    }),
  );
  assert.match((await cli(['orient'], { cwd: r.dir })).stdout, /units running in this session: unit\(mine111\), unit\(other22\)\n/);
  assert.match(await ctx(r.dir), /units running in this session: unit\(mine111\)\n/);
  assert.deepEqual(Object.keys(JSON.parse(r.read('.work/CD-8/running.json'))), ['mine111']);
});

/**
 * Run the session-start launcher `moderator sync` writes, as Claude Code runs it: its input on stdin.
 * @param {string} dir
 * @param {Record<string, string>} extra
 * @param {() => void} [whileRunning]
 */
function launch(dir, extra, whileRunning = () => {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', [`${dir}/.claude/hooks/moderator-session-start.sh`], { cwd: dir, env: env({ CLAUDE_PROJECT_DIR: dir, ...extra }) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ cwd: dir, source: 'startup', session_id: 's1' }));
    whileRunning();
  });
}

test('a session start that races the install waits for the client, then gives the start context; no proxy warning', async () => {
  const r = repo({ branch: 'cd-9-x' });
  await cli(['sync'], { cwd: r.dir });
  const install = () =>
    setTimeout(() => {
      fs.mkdirSync(`${r.dir}/node_modules/@parlornights`, { recursive: true });
      fs.symlinkSync(CLIENT, `${r.dir}/node_modules/@parlornights/moderator`);
    }, 1500);
  const out = /** @type {any} */ (await launch(r.dir, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9' }, install));
  assert.equal(out.status, 0, out.stderr);
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /orient: branch cd-9-x .* issue CD-9/);
  assert.doesNotMatch(out.stderr, /UNDICI-EHPA/);
});

test('a client that never installs costs the session its start context, said in one line, never a failed hook', async () => {
  const r = repo({ branch: 'cd-10-x' });
  await cli(['sync'], { cwd: r.dir });
  const out = /** @type {any} */ (await launch(r.dir, { MODERATOR_INSTALL_WAIT: '1' }));
  assert.equal(out.status, 0);
  assert.match(JSON.parse(out.stdout).systemMessage, /the client did not load within 1 s of the session start \(Error: Cannot find module '[^']*moderator\.js'\)/);
});
