// Session start: the role first, then the orient block that names the handoff note by path, then the issue, the
// repo's start docs and the papercut log; all under Claude Code's hook cap.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { CONFIG, hook, repo } from './helpers.js';

const { fitSessionContext } = await import('../src/orient.js');
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
