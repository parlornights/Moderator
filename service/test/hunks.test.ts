import { describe, expect, it } from 'vitest';

import { diffHash, existingTestHunks, isTestPath, splitPatch } from '../src/hunks';

describe('isTestPath', () => {
  it('knows test files, fixtures and snapshots', () => {
    for (const p of ['src/__tests__/a.ts', 'apps/app/e2e/home.spec.ts', 'x/y.test.tsx', 'infra/test/run.mjs', 'a/fixtures/b.json', 'a/__snapshots__/b.snap', 'e2e/home.spec.ts-snapshots/home.png', 'apps/app/vitest.config.mts', 'vitest.setup.ts', 'apps/app/src/api/mock/games.ts', 'packages/x/src/test-support/make.ts', 'src/__mocks__/fs.ts', 'playwright.config.ts'])
      expect(isTestPath(p), p).toBe(true);
    for (const p of ['src/app.ts', 'docs/testing.md', 'src/contest.ts', 'package.json', 'apps/app/vite.config.ts', '.github/workflows/gate.yml']) expect(isTestPath(p), p).toBe(false);
  });
});

describe('splitPatch', () => {
  it('splits at each @@ header', () => {
    expect(splitPatch('@@ -1,2 +1,2 @@\n-a\n+b\n@@ -9 +9 @@\n-c')).toEqual(['@@ -1,2 +1,2 @@\n-a\n+b', '@@ -9 +9 @@\n-c']);
  });
});

describe('existingTestHunks', () => {
  it('keeps hunks of changed, removed and renamed tests; leaves out new test files and source', () => {
    const hunks = existingTestHunks([
      { filename: 'a.test.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y\n@@ -5 +5 @@\n-z' },
      { filename: 'b.test.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+new' },
      { filename: 'packages/core/vitest.config.ts', status: 'added', patch: "@@ -0,0 +1 @@\n+export default { test: { exclude: ['**'] } }" },
      { filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { filename: 'renamed.ts', previousFilename: 'old.test.ts', status: 'renamed', patch: '@@ -1 +1 @@\n-p\n+q' },
      { filename: 'e2e/home.spec.ts-snapshots/home.png', status: 'modified' },
    ]);
    expect(hunks.map((h) => [h.file, h.patch])).toEqual([
      ['a.test.ts', '@@ -1 +1 @@\n-x\n+y'],
      ['a.test.ts', '@@ -5 +5 @@\n-z'],
      ['packages/core/vitest.config.ts', "@@ -0,0 +1 @@\n+export default { test: { exclude: ['**'] } }"],
      ['renamed.ts', '@@ -1 +1 @@\n-p\n+q'],
      ['e2e/home.spec.ts-snapshots/home.png', null],
    ]);
  });
});

describe('diffHash', () => {
  it('ignores line numbers and order, and changes with any changed line, file or status', async () => {
    const a = { filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' };
    const b = { filename: 'b.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+z' };
    const base = await diffHash([a, b]);
    expect(await diffHash([b, { ...a, patch: '@@ -40 +40 @@\n-x\n+y' }])).toBe(base);
    expect(await diffHash([a, { ...b, patch: '@@ -0,0 +1 @@\n+w' }])).not.toBe(base);
    expect(await diffHash([a])).not.toBe(base);
    expect(await diffHash([{ ...a, status: 'renamed' }, b])).not.toBe(base);
  });
});
