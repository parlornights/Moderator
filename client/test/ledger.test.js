// The small writers of the ledger: a unit's start, the note before a compaction, and the note's staleness exit code.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cli, hook, repo } from './helpers.js';

test('a unit start is recorded in running.json and as an event', async () => {
  const r = repo({ branch: 'cd-1-x' });
  await hook('subagent-start', { agent_id: 'abcdef123456', agent_type: 'moderator:unit' }, { cwd: r.dir });
  const running = JSON.parse(r.read('.work/CD-1/running.json'));
  assert.equal(running.abcdef123456.agent_type, 'moderator:unit');
  assert.match(r.read('.work/CD-1/events.jsonl'), /"kind":"unit:start","branch":"cd-1-x","agent":"moderator:unit","id":"abcdef12"/);
});

test("a unit start records its session, and drops other sessions' units and units started more than a day ago", async () => {
  const r = repo({ branch: 'cd-1-x' });
  const now = new Date().toISOString();
  r.put('.work/CD-1/running.json', JSON.stringify({ mine: { agent_type: 'unit', started: now, session: 's1' }, other: { agent_type: 'unit', started: now, session: 's0' }, old: { agent_type: 'unit', started: '2026-01-01T00:00:00Z', session: 's1' } }));
  await hook('subagent-start', { agent_id: 'new', agent_type: 'unit', session_id: 's1' }, { cwd: r.dir });
  const running = JSON.parse(r.read('.work/CD-1/running.json'));
  assert.deepEqual(Object.keys(running), ['mine', 'new']);
  assert.equal(running.new.session, 's1');
});

test('before a compaction the note is written and committed on a task branch, alone', async () => {
  const r = repo({ branch: 'cd-2-x' });
  r.put('a.js', 'unrelated edit');
  r.put('t.jsonl', JSON.stringify({ type: 'user', message: { content: 'what we were doing' } }) + '\n');
  await hook('pre-compact', { trigger: 'auto', transcript_path: `${r.dir}/t.jsonl` }, { cwd: r.dir });
  assert.equal(r.git('log', '-1', '--format=%s'), 'wip(CD-2): handoff before compaction');
  assert.deepEqual(r.git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['.work/CD-2/handoff.md']);
  assert.match(r.read('.work/CD-2/handoff.md'), /U: what we were doing/);
});

test('`moderator handoff --stale` exits 1 with the reason, 0 when current', async () => {
  const r = repo({ branch: 'cd-3-x' });
  const none = await cli(['handoff', '--stale'], { cwd: r.dir });
  assert.deepEqual([none.status, none.stdout.trim()], [1, 'there is no handoff note yet']);
  r.put('.work/CD-3/handoff.md', 'status: done\n');
  const done = await cli(['handoff', '--stale'], { cwd: r.dir });
  assert.deepEqual([done.status, done.stdout.trim()], [0, 'current']);
});
