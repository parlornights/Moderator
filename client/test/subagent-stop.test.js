// A unit stops with a hand-back the parent can act on, or an escalation; anything else is sent back, at most three
// times. Jev judges a NEEDS DECISION line and the criteria against the diff, and Jev not answering blocks nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { CONFIG, fakeModerator, hook, repo } from './helpers.js';

const HANDBACK = (over = {}) =>
  'HANDBACK\n' +
  JSON.stringify({ status: 'done', issue: 'CD-1', branch: 'cd-1-x', pr: 3, scope: [], gate: 'x', tests: 'added 1 (a.test.js)', review: { model: 'sonnet', findings: 0, fixed: 0, declined: 0, declinedWhy: '' }, notes: '', papercuts: [], ...over });

async function setup(jev = () => ({ outcome: 'not_run', reason: 'jev_down' }), checks = { unit: { when: 'always', cmd: 'true' } }) {
  const moderator = await fakeModerator((route, body) => jev(route, body));
  const r = repo({ branch: 'cd-1-x', config: { ...CONFIG, moderatorUrl: moderator.url, checks } });
  r.put('.work/CD-1/running.json', JSON.stringify({ u1: { agent_type: 'unit' } }));
  const stop = async (message) => (await hook('subagent-stop', { agent_id: 'u1', agent_type: 'unit', last_assistant_message: message }, { cwd: r.dir })).json;
  const events = () => r.read('.work/CD-1/events.jsonl').trim().split('\n').map((l) => JSON.parse(l).kind);
  return { r, moderator, stop, events };
}

test('a valid done hand-back with a green gate goes through, and the unit is no longer running', async () => {
  const { r, stop, events } = await setup();
  assert.equal(await stop(HANDBACK()), null);
  assert.deepEqual(JSON.parse(r.read('.work/CD-1/running.json')), {});
  assert.deepEqual(events(), ['gate', 'unit:handback']);
});

test('not a hand-back, or a red gate, is sent back; after three blocks the unit is let through', async () => {
  const { stop, events } = await setup(undefined, { unit: { when: 'always', cmd: 'echo "✗ broken"; exit 1' } });
  const first = await stop('I think it works.');
  assert.match(first.reason, /not a hand-back.*End with the HANDBACK block/s);
  assert.match(first.reason, /block 1 of 3/);
  const red = await stop(HANDBACK());
  assert.match(red.reason, /Gate is not green.*✗ broken/s);
  await stop(HANDBACK());
  assert.equal(await stop(HANDBACK()), null);
  assert.equal(events().at(-1), 'unit:forced');
});

test('BLOCKED goes through; NEEDS DECISION goes through unless Jev reads it as not one whole question', async () => {
  const verdicts = [];
  const { moderator, stop, events } = await setup((route) => (route === 'POST /tool/jev/needs-decision' ? { outcome: 'done', result: verdicts.shift() } : { outcome: 'not_run' }));
  assert.equal(await stop('BLOCKED: wb is offline since 10:00'), null);
  verdicts.push({ pass: false, checks: {} });
  const refused = await stop('Looked at it.\nNEEDS DECISION: what should I do about the test?');
  assert.match(refused.reason, /does not ask one whole question.*NEEDS DECISION: <question> \| options/s);
  assert.deepEqual(moderator.calls.at(-1).body, { escalation: 'what should I do about the test?' });
  verdicts.push({ pass: true, checks: {} });
  assert.equal(await stop('NEEDS DECISION: star or grid? | options: A star / B grid | recommend: A because it reads at 16 px'), null);
  assert.deepEqual(events(), ['unit:escalate-blocked', 'unit:blocked', 'unit:escalate-decision']);
});

test('Jev down lets a NEEDS DECISION line through unjudged', async () => {
  const { stop } = await setup();
  assert.equal(await stop('NEEDS DECISION: anything'), null);
});

test('with criteria written down, a criterion Jev reads as missing sends the unit back', async () => {
  const { r, moderator, stop } = await setup((route) =>
    route === 'POST /tool/jev/verdict'
      ? { outcome: 'done', result: { pass: false, results: [{ criterion: 'names are capped at 24', p: 0.1 }, { criterion: 'rename survives a reload', p: 0.9 }], block: [{ criterion: 'names are capped at 24', p: 0.1 }] } }
      : { outcome: 'not_run' },
  );
  r.put('.work/CD-1/criteria.md', '- names are capped at 24\n- rename survives a reload\n');
  r.put('src/name.js', 'export const cap = 24;\n');
  r.git('add', '-A');
  r.git('commit', '-qm', 'cap names');
  const out = await stop(HANDBACK());
  assert.match(out.reason, /0\.1 {2}names are capped at 24/);
  const call = moderator.calls.find((c) => c.route === 'POST /tool/jev/verdict').body;
  assert.deepEqual(call.criteria, ['names are capped at 24', 'rename survives a reload']);
  assert.match(call.diff, /export const cap = 24/);
  assert.doesNotMatch(call.diff, /\.work/);
});

test("the unit's papercuts go into the log, by category", async () => {
  const { r, stop } = await setup();
  await stop(HANDBACK({ papercuts: ['scope: theme/** maps to no check -> map it', 'the brief lacked the design link'] }));
  const log = r.read('docs/papercuts.md');
  assert.match(log, /\| CD-1 \| scope \| theme\/\*\* maps to no check -> map it/);
  assert.match(log, /\| CD-1 \| protocol \| the brief lacked the design link/);
});

test('a malformed hook input never traps a unit', async () => {
  const { stop } = await setup();
  assert.equal(await stop(undefined), null);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'never')), false);
});
