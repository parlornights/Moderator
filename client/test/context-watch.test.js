// A session past its hand-over share is told once to hand over, firmer at the urgent share, again after a compaction;
// the Stop hook holds it until the note changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { hook, repo, toolUse, transcript } from './helpers.js';

const { contextTokens } = await import('../src/transcript.js');
const { contextHandoffDue } = await import('../src/handoff.js');

const turn = (tokens, extra = {}) => ({ ...extra, message: { role: 'assistant', usage: { input_tokens: 2, cache_read_input_tokens: tokens - 2, cache_creation_input_tokens: 0 } } });
const setup = (branch = 'cd-5-x') => {
  const r = repo({ branch });
  r.put(`.work/${branch.slice(0, 4).toUpperCase()}/handoff.md`, 'status: in-progress\n\n## Next step\na\n');
  const watch = async (tokens, session = 's1', extra = {}) =>
    (await hook('context-watch', { transcript_path: transcript(r.scratch, [turn(tokens)]), session_id: session, ...extra }, { cwd: r.dir })).stdout;
  return { r, watch };
};

test('the context is the latest main-session usage; a unit (sidechain) turn does not count; an old line is still found', () => {
  const { r } = setup();
  assert.equal(contextTokens(transcript(r.scratch, [turn(100), turn(300), turn(900, { isSidechain: true }), { type: 'user' }])), 300);
  assert.equal(contextTokens(`${r.scratch}/none.jsonl`), null);
  assert.equal(contextTokens(transcript(r.scratch, [turn(555_000), { type: 'user', message: { content: 'x'.repeat(200 * 1024) } }])), 555_000);
});

test('below the share it says nothing; past it once per level, firmer at 85 %', async () => {
  const { watch } = setup();
  assert.equal(await watch(690_000), '');
  const first = await watch(710_000);
  assert.match(first, /71% of the 1000k window/);
  assert.match(first, /\.work\/CD-5\/handoff\.md/);
  assert.equal(await watch(720_000), '');
  assert.match(await watch(860_000), /URGENT/);
  assert.equal(await watch(870_000), '');
});

test("a unit's tool call is not the parent's budget: silent, and nothing recorded", async () => {
  const { r, watch } = setup();
  assert.equal(await watch(900_000, 's1', { agent_type: 'unit', agent_id: 'a1' }), '');
  assert.equal(fs.existsSync(`${r.dir}/.work/CD-5/events.jsonl`), false);
});

test('after a compaction the same level warns again', async () => {
  const { r, watch } = setup();
  assert.match(await watch(710_000), /71%/);
  assert.equal(await watch(720_000), '');
  fs.appendFileSync(`${r.dir}/.work/CD-5/events.jsonl`, JSON.stringify({ t: new Date(Date.now() + 1000).toISOString(), kind: 'session-start', source: 'compact', session: 's1' }) + '\n');
  assert.match(await watch(730_000), /73%/);
});

test('the Stop hook holds the session until the note changes after the crossing', async () => {
  const { r, watch } = setup();
  await watch(710_000);
  process.chdir(r.dir);
  assert.match(contextHandoffDue({ sessionId: 's1' }), /passed 71%/);
  assert.equal(contextHandoffDue({ sessionId: 'other' }), null);
  r.put('.work/CD-5/handoff.md', 'status: in-progress\n\n## Next step\nthe next session picks up #163\n');
  assert.equal(contextHandoffDue({ sessionId: 's1' }), null);
});

test('the share and the window come from the config', async () => {
  const r = repo({ branch: 'cd-6-x', config: { issuePattern: 'CD-\\d+', context: { window: 200_000, handoffShare: 0.5 } } });
  const t = transcript(r.scratch, [toolUse('Bash', {}), turn(110_000)]);
  assert.match((await hook('context-watch', { transcript_path: t, session_id: 's' }, { cwd: r.dir })).stdout, /55% of the 200k window \(handoff at 50%\)/);
});
