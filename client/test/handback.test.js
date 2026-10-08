// A unit's last message is a hand-back the parent can act on: its shape, a green gate for the tree as it is, the
// reviewer the risk asks for, tests for new source, and the branch's issue.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cli, repo } from './helpers.js';

const { checkHandback, parseHandback } = await import('../src/handback.js');
const { computeRisk } = await import('../src/risk.js');

const CONFIG = {
  issuePattern: '\\bCD-\\d+\\b',
  ignore: ['.work/**'],
  lintExtensions: ['.js'],
  checks: { unit: { when: 'always', cmd: 'true' } },
  risk: { highPaths: ['src/auth/**'], srcLinesNeedingTests: 3 },
};
const handback = (over = {}) =>
  'Done.\n\nHANDBACK\n' +
  JSON.stringify({ status: 'done', issue: 'CD-1', branch: 'cd-1-x', pr: 1, scope: [], gate: 'abc', tests: 'added 1 (a.test.js)', review: { model: 'sonnet', findings: 0, fixed: 0, declined: 0, declinedWhy: '' }, notes: '', papercuts: [], ...over });

test('a done hand-back names the reviewer model the parent will run', () => {
  assert.equal(parseHandback(handback()).ok, true);
  assert.equal(parseHandback(handback({ review: { model: 'opus', findings: 0, fixed: 0, declined: 0, declinedWhy: '' } })).ok, true);
  const missing = parseHandback(handback({ review: { findings: 0, fixed: 0, declined: 0, declinedWhy: '' } }));
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(), /review\.model/);
});

test('escalations are one last line; anything else is not a hand-back', () => {
  assert.deepEqual(parseHandback('tried\nBLOCKED: wb is offline since 10:00'), { ok: true, kind: 'blocked', text: 'wb is offline since 10:00', errors: [] });
  assert.equal(parseHandback('NEEDS DECISION: star or grid? | options: A / B | recommend: A because it reads').kind, 'decision');
  assert.equal(parseHandback('I am done').kind, 'none');
  assert.match(parseHandback('HANDBACK\n{"status": "done"').errors.join(), /not valid JSON/);
  assert.match(parseHandback(`${handback()}\nthanks`).errors.join(), /not valid JSON|nothing may follow/);
  assert.match(parseHandback(handback({ status: 'finished' })).errors.join(), /done \| blocked \| partial/);
});

test('done needs a green gate on this very tree', async () => {
  const r = repo({ branch: 'cd-1-x', config: CONFIG });
  process.chdir(r.dir);
  r.put('a.js', 'x');
  assert.match(checkHandback(handback()).errors.join(), /no GREEN gate result/);
  await cli(['gate'], { cwd: r.dir });
  const green = checkHandback(handback());
  assert.equal(green.ok, true, green.errors.join());
  assert.match(green.warnings.join(), /"gate" says abc/);
  r.put('a.js', 'y');
  assert.match(checkHandback(handback()).errors.join(), /the tree changed after the last green gate/);
});

test('a sensitive path needs an opus review, new source needs tests, and the issue must be the branch\'s', async () => {
  const r = repo({ branch: 'cd-2-x', config: CONFIG });
  process.chdir(r.dir);
  r.put('src/auth/token.js', 'a\nb\nc\nd\n');
  assert.deepEqual([computeRisk().level, computeRisk().model, computeRisk().needsTests], ['high', 'opus', true]);
  await cli(['gate'], { cwd: r.dir });
  const errors = checkHandback(handback({ issue: 'CD-9' })).errors.join('\n');
  assert.match(errors, /needs an opus review/);
  assert.match(errors, /source lines added and 0 test lines/);
  assert.match(errors, /"issue" CD-9 does not match the branch \(CD-2\)/);
  const fixed = checkHandback(handback({ issue: 'CD-2', tests: 'n/a: a config move', review: { model: 'opus', findings: 0, fixed: 0, declined: 0, declinedWhy: '' } }));
  assert.equal(fixed.ok, true, fixed.errors.join());
});
