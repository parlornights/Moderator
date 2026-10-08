// moderator.config.json is the repo's own rules: read, validated with a message that names the file, never guessed.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { repo } from './helpers.js';

const { config } = await import('../src/config.js');

// The config is cached per repository, so each case gets a repository of its own.
const load = async (dir) => {
  process.chdir(dir);
  return config();
};

test('a minimal config gets every default', async () => {
  const r = repo({ config: { issuePattern: 'ABC-\\d+' } });
  const c = await load(r.dir);
  assert.equal(c.base, 'origin/main');
  assert.equal(c.papercuts, 'docs/papercuts.md');
  assert.deepEqual(c.risk.testGlobs, ['**/*.test.*', '**/*.spec.*', '**/__tests__/**']);
  assert.equal(c.risk.linesHigh, 400);
  assert.deepEqual(c.context, { window: 1_000_000, handoffShare: 0.7 });
  assert.deepEqual(c.checks, {});
});

test('no config file is no config, not an error', async () => {
  assert.equal(await load(repo({ config: null }).dir), null);
});

test('a typo, a bad pattern or broken JSON is an error naming the file', async () => {
  await assert.rejects(load(repo({ config: { issuePattern: 'A-\\d+', ignroe: [] } }).dir), /moderator\.config\.json: .*ignroe/s);
  await assert.rejects(load(repo({ config: { issuePattern: '(' } }).dir), /moderator\.config\.json: .*not a valid regular expression/s);
  const broken = repo({ config: null });
  broken.put('moderator.config.json', '{ "issuePattern": ');
  await assert.rejects(load(broken.dir), /moderator\.config\.json: /);
});

test('a check needs a known "when" and a command', async () => {
  await assert.rejects(load(repo({ config: { issuePattern: 'A-\\d+', checks: { e2e: { when: 'e2e', cmd: 'x' } } } }).dir), /when/);
  await assert.rejects(load(repo({ config: { issuePattern: 'A-\\d+', checks: { lint: { when: 'files' } } } }).dir), /cmd/);
});
