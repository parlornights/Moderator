// The gate: the diff becomes a plan from the repo's config, the plan runs as CI runs it, a failure shows only the
// lines that matter, and a green result is tied to the tree it ran on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { cli, repo } from './helpers.js';

const { checkEnv, relevantTail } = await import('../src/gate.js');
const { computeScope } = await import('../src/scope.js');

const CONFIG = {
  issuePattern: '\\bCD-\\d+\\b',
  ignore: ['**/*.md', '.work/**'],
  global: ['pnpm-lock.yaml'],
  lintExtensions: ['.js'],
  checks: {
    lint: { when: 'files', order: 10, cmd: 'echo lint {files}' },
    unit: { when: 'packages', order: 30, cmd: 'echo unit {filters}' },
    balance: { when: 'rule', order: 35, cmd: 'echo balance' },
    smoke: { when: 'always', order: 90, cmd: 'echo smoke', skipAfterFailure: true },
  },
  rules: [{ name: 'bot balance', match: ['packages/game/**'], checks: ['balance'] }],
};
const FILES = { 'packages/game/package.json': '{"name":"@x/game"}', 'packages/ui/package.json': '{"name":"@x/ui"}', 'README.md': 'x' };

test('the seed line survives when only failure lines are kept', () => {
  const out = [
    'apps/app test: vitest app: shuffled with seed 1791349702801, rerun with --sequence.seed=1791349702801',
    'apps/app test: vitest app: 281 files, 3488 passed, 1 failed (8m13s)',
    'apps/app test: ✗ apps/app/src/ui/components/toast.test.tsx › clears its pending timeout',
    ' ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @wg/app@0.1.0 test',
    ' ELIFECYCLE  Test failed.',
    ...Array.from({ length: 60 }, (_, i) => `noise ${i}`),
  ].join('\n');
  const tail = relevantTail(out);
  assert.match(tail, /✗ apps\/app\/src\/ui\/components\/toast\.test\.tsx/);
  assert.match(tail, /--sequence\.seed=1791349702801/);
});

test("vitest's own seed line survives the plain tail as well; a run with no seed line is unchanged", () => {
  assert.match(relevantTail(['Running tests with seed "105"', ...Array.from({ length: 80 }, (_, i) => `line ${i}`)].join('\n')), /Running tests with seed "105"/);
  const out = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(relevantTail(out), out);
});

test('a check runs with CI\'s environment: no session proxy flag, CI set, no colour', () => {
  const env = checkEnv({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://proxy', PATH: '/bin' });
  assert.equal('NODE_USE_ENV_PROXY' in env, false);
  assert.equal(env.HTTPS_PROXY, 'http://proxy');
  assert.equal(checkEnv({}).CI, '1');
  assert.equal(checkEnv({ CI: 'true' }).CI, 'true');
  assert.equal(checkEnv({}).FORCE_COLOR, '0');
});

test('the plan follows the diff: lint for lintable files, unit per changed package, a rule adds its check, ignored files count for nothing', () => {
  const r = repo({ branch: 'cd-1-x', config: CONFIG, files: FILES });
  process.chdir(r.dir);
  r.put('docs/notes.md', 'x');
  assert.deepEqual(computeScope().checks.map((c) => c.id), ['smoke']);

  r.put('packages/ui/button.js', 'x');
  const s = computeScope();
  assert.deepEqual(s.packages, ['@x/ui']);
  assert.deepEqual(s.checks.map((c) => c.id), ['lint', 'unit', 'smoke']);
  assert.equal(s.checks[0].cmd, "echo lint 'packages/ui/button.js'");
  assert.equal(s.checks[1].cmd, "echo unit --filter '...@x/ui'");
  assert.deepEqual(s.skipped.map((k) => k.id), ['balance']);

  r.put('packages/game/rules.js', 'x');
  assert.deepEqual(computeScope().checks.map((c) => c.id), ['lint', 'unit', 'balance', 'smoke']);
  assert.deepEqual(computeScope().rules, ['bot balance']);
});

test('a file name is one shell word in a command, whatever it contains', async () => {
  const r = repo({ branch: 'cd-6-x', config: { ...CONFIG, checks: { lint: { when: 'files', cmd: 'printf "<%s>" {files}' } } }, files: FILES });
  r.put("packages/ui/it's $(touch pwned).js", 'x');
  const run = await cli(['gate'], { cwd: r.dir });
  assert.equal(run.status, 0, run.stdout);
  assert.match(r.read('.work/CD-6/gate-lint.log'), /<packages\/ui\/it's \$\(touch pwned\)\.js>/);
  assert.equal(fs.existsSync(path.join(r.dir, 'pwned')), false);
});

test('a global file runs every check for every package', () => {
  const r = repo({ branch: 'cd-2-x', config: CONFIG, files: FILES });
  process.chdir(r.dir);
  r.put('pnpm-lock.yaml', 'x');
  const s = computeScope();
  assert.equal(s.global, true);
  assert.equal(s.checks.find((c) => c.id === 'unit').cmd, 'echo unit -r');
  assert.ok(s.checks.some((c) => c.id === 'balance'));
});

test('the gate runs the plan, prints GREEN with the tree hash, and reuses it while the tree is unchanged', async () => {
  const r = repo({ branch: 'cd-3-x', config: CONFIG, files: FILES });
  r.put('packages/ui/a.js', 'x');
  const first = await cli(['gate'], { cwd: r.dir });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const hash = first.stdout.match(/gate: GREEN \(\d+s\) CD-3 tree (\w{12})/)[1];
  const gate = JSON.parse(r.read('.work/CD-3/gate.json'));
  assert.equal(gate.treeHash, hash);
  assert.deepEqual(gate.checks.map((c) => `${c.id}:${c.status}`), ['lint:pass', 'unit:pass', 'smoke:pass']);
  assert.match((await cli(['gate', '--if-changed'], { cwd: r.dir })).stdout, new RegExp(`GREEN \\(cached, tree ${hash}`));
  r.put('packages/ui/a.js', 'y');
  assert.doesNotMatch((await cli(['gate', '--if-changed'], { cwd: r.dir })).stdout, /cached/);
});

test('a failure shows its relevant lines and skips what waits on it; a partial run is never the trusted result', async () => {
  const failing = { ...CONFIG, checks: { ...CONFIG.checks, unit: { when: 'packages', order: 30, cmd: 'echo "✗ ui.test.js › renders"; exit 1' } } };
  const r = repo({ branch: 'cd-4-x', config: failing, files: FILES });
  r.put('packages/ui/a.js', 'x');
  const run = await cli(['gate'], { cwd: r.dir });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /gate: FAIL/);
  assert.match(run.stdout, /--- unit \(fail; relevant lines, full log: \.work\/CD-4\/gate-unit\.log\)\n✗ ui\.test\.js › renders/);
  assert.match(run.stdout, /- smoke skipped: earlier check failed/);
  fs.rmSync(path.join(r.dir, '.work/CD-4/gate.json'));
  assert.equal((await cli(['gate', '--only', 'lint'], { cwd: r.dir })).status, 0);
  assert.equal(fs.existsSync(path.join(r.dir, '.work/CD-4/gate.json')), false);
});

test('scope --json carries what CI reads: the merge base and the planned check ids', async () => {
  const r = repo({ branch: 'cd-5-x', config: CONFIG, files: FILES });
  r.put('packages/game/a.js', 'x');
  const plan = JSON.parse((await cli(['scope', '--json'], { cwd: r.dir })).stdout);
  assert.match(plan.mergeBase, /^[0-9a-f]{40}$/);
  assert.ok(plan.checks.some((c) => c.id === 'balance'));
});
