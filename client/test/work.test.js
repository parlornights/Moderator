// The issue comes from the branch name only: a stray .work/current or a word that looks like an id never pins one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { repo } from './helpers.js';

const { appendEvent, issueId, readEvents } = await import('../src/work.js');

test('the branch names the issue, matched by the repo pattern, upper-cased', () => {
  for (const [branch, id] of [
    ['cd-12-rename-games', 'CD-12'],
    ['claude/par-29-moderator-client', 'PAR-29'],
    ['claude/design-motion-rules-1006', null],
    ['fix-utf-8', null],
    ['es-2026', null],
  ]) {
    const r = repo({ branch });
    process.chdir(r.dir);
    assert.equal(issueId(), id, branch);
  }
});

test('.work/current is not read', () => {
  const r = repo({ branch: 'no-issue-here' });
  r.put('.work/current', 'CD-9\n');
  process.chdir(r.dir);
  assert.equal(issueId(), null);
});

test('without a config there is no issue', () => {
  process.chdir(repo({ branch: 'cd-3-x', config: null }).dir);
  assert.equal(issueId(), null);
});

test('events are appended to .work/<issue>/events.jsonl and read back by kind, oldest first', () => {
  const r = repo({ branch: 'cd-4-x' });
  process.chdir(r.dir);
  appendEvent('a', { n: 1 });
  appendEvent('b', { n: 2 });
  appendEvent('a', { n: 3 });
  fs.appendFileSync(path.join(r.dir, '.work/CD-4/events.jsonl'), 'not json\n');
  assert.deepEqual(readEvents('a').map((e) => e.n), [1, 3]);
  assert.deepEqual(readEvents().map((e) => e.kind), ['a', 'b', 'a']);
  assert.equal(readEvents('a')[0].branch, 'cd-4-x');
});
