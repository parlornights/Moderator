// A unit's last message is a hand-back the parent can act on: its shape, a green gate for the tree as it is, the
// reviewer the risk asks for, tests for new source, the branch's issue, and a proof page for a diff touching proofPaths.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cli, fakeModerator, repo } from './helpers.js';

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

test("the task's own ledger never counts toward the risk, even with no ignore rule", () => {
  const r = repo({ branch: 'cd-3-x', config: { issuePattern: '\\bCD-\\d+\\b', lintExtensions: ['.js'], risk: { linesHigh: 50, filesHigh: 3 } } });
  process.chdir(r.dir);
  for (const f of ['handoff.md', 'events.jsonl', 'gate.json', 'gate-unit.log']) r.put(`.work/CD-3/${f}`, 'x\n'.repeat(100));
  r.git('add', '-A');
  r.git('commit', '-qm', 'wip(CD-3): checkpoint');
  r.put('.work/CD-3/gate-lint.log', 'y\n'.repeat(100));
  r.put('a.js', 'x');
  const risk = computeRisk();
  assert.deepEqual([risk.level, risk.files, risk.added], ['normal', 1, 1]);
});

test('Jev may raise the reviewer to opus, never lower it, and reads only paths, counts and commit subjects', async () => {
  const answers = [];
  const moderator = await fakeModerator(() => ({ outcome: 'done', result: answers.shift() }));
  const config = { ...CONFIG, moderatorUrl: moderator.url };
  const r = repo({ branch: 'cd-4-x', config });
  r.put('src/a.js', 'x');
  r.git('add', '-A');
  r.git('commit', '-qm', 'cap names at 24');
  answers.push({ opus: true, p: 0.8 });
  assert.match((await cli(['risk'], { cwd: r.dir })).stdout, /^risk: high \(jev: strong review \(p=0\.8\)\) -> reviewer: opus/);
  assert.deepEqual(moderator.calls[0].body, { files: ['src/a.js'], numstat: ['1\t0\tsrc/a.js'], commits: ['cap names at 24'] });
  answers.push({ opus: false, p: 0.1 });
  assert.match((await cli(['risk'], { cwd: r.dir })).stdout, /^risk: normal -> reviewer: sonnet/);
  r.put('src/auth/token.js', 'x');
  answers.push({ opus: false, p: 0.1 });
  assert.match((await cli(['risk'], { cwd: r.dir })).stdout, /^risk: high \(sensitive path: src\/auth\/token\.js\) -> reviewer: opus/);
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

test('a diff touching proofPaths needs an Artifact URL as "proof"; elsewhere "none: ..." is fine', async () => {
  const r = repo({ branch: 'cd-5-x', config: { ...CONFIG, proofPaths: ['app/screens/**'] } });
  process.chdir(r.dir);
  r.put('lib/a.js', 'x');
  r.put('lib/a.test.js', 'x');
  await cli(['gate'], { cwd: r.dir });
  const none = checkHandback(handback({ issue: 'CD-5', proof: 'none: a library change' }));
  assert.equal(none.ok, true, none.errors.join());

  r.put('app/screens/Lobby.js', 'x');
  await cli(['gate'], { cwd: r.dir });
  const missing = checkHandback(handback({ issue: 'CD-5' }));
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(), /touches proofPaths \(app\/screens\/Lobby\.js\).*it is missing/);
  assert.match(checkHandback(handback({ issue: 'CD-5', proof: '' })).errors.join(), /it is missing/);
  assert.match(checkHandback(handback({ issue: 'CD-5', proof: 'none: nothing visible' })).errors.join(), /touches proofPaths .*"none: nothing visible"/);
  const url = checkHandback(handback({ issue: 'CD-5', proof: 'https://claude.ai/artifact/abc' }));
  assert.equal(url.ok, true, url.errors.join());
});

test('with no proofPaths no proof is required, and a proof given is an Artifact URL or "none: <reason>"', async () => {
  const r = repo({ branch: 'cd-6-x', config: CONFIG });
  process.chdir(r.dir);
  r.put('app/screens/Lobby.js', 'x');
  r.put('app/screens/Lobby.test.js', 'x');
  await cli(['gate'], { cwd: r.dir });
  const res = checkHandback(handback({ issue: 'CD-6' }));
  assert.equal(res.ok, true, res.errors.join());
  assert.equal(parseHandback(handback({ proof: 'none: a refactor' })).ok, true);
  assert.match(parseHandback(handback({ proof: 'http://example.com/shots' })).errors.join(), /"proof" must be an Artifact URL/);
  assert.match(parseHandback(handback({ proof: 'none:' })).errors.join(), /"proof" must be an Artifact URL/);
});
