// The papercut log: an entry goes under Unconsolidated with its date, issue and category; a consolidation moves them.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cli, repo } from './helpers.js';

test('add, list and mark', async () => {
  const r = repo({ branch: 'cd-7-x' });
  assert.match((await cli(['papercut', 'gate', 'lint ran twice -> skip it'], { cwd: r.dir })).stdout, /^- \d{4}-\d{2}-\d{2} \| CD-7 \| gate \| lint ran twice -> skip it$/m);
  await cli(['papercut', 'flake', 'toast.test times out'], { cwd: r.dir });
  assert.match(r.read('docs/papercuts.md'), /## Unconsolidated\n\n?- .* \| gate \| lint ran twice -> skip it\n- .* \| flake \| toast\.test times out\n/);
  assert.match((await cli(['papercut', '--list'], { cwd: r.dir })).stdout, /gate \(1\):\n {2}- .*\nflake \(1\):/);
  assert.equal((await cli(['papercut', 'oops', 'x'], { cwd: r.dir })).status, 1);
  assert.match((await cli(['papercut', '--mark'], { cwd: r.dir })).stdout, /marked 2 entries/);
  assert.match(r.read('docs/papercuts.md'), /## Unconsolidated\n\n## Consolidated \d{4}-\d{2}-\d{2}\n\n- .* \| gate \|.*\n- .* \| flake \|/);
  assert.match((await cli(['papercut', '--list'], { cwd: r.dir })).stdout, /no unconsolidated papercuts/);
  await cli(['papercut', 'repo', 'no typecheck script'], { cwd: r.dir });
  assert.match(r.read('docs/papercuts.md'), /## Unconsolidated\n- .* \| repo \| no typecheck script\n\n## Consolidated/);
});
