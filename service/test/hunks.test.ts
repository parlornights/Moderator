import { describe, expect, it } from 'vitest';

import { diffHash, existingTestHunks, isTestPath, splitPatch } from '../src/hunks';

describe('isTestPath', () => {
  it('knows test files by their .test., .spec. or .e2e. infix, and nothing else', () => {
    for (const p of ['x/y.test.tsx', 'apps/app/e2e/home.spec.ts', 'infra/run.test.mjs', 'a/flow.e2e.ts', '.hidden/a.test.js'])
      expect(isTestPath(p), p).toBe(true);
    for (const p of ['src/app.ts', 'src/__tests__/helpers.ts', 'test/setup.ts', 'vitest.config.ts', 'src/__mocks__/fs.ts', 'a/__snapshots__/b.snap', 'package.json', 'src/contest.ts'])
      expect(isTestPath(p), p).toBe(false);
  });
});

describe('splitPatch', () => {
  it('splits at each @@ header', () => {
    expect(splitPatch('@@ -1,2 +1,2 @@\n-a\n+b\n@@ -9 +9 @@\n-c')).toEqual(['@@ -1,2 +1,2 @@\n-a\n+b', '@@ -9 +9 @@\n-c']);
  });
});

describe('existingTestHunks', () => {
  it('keeps hunks of changed, removed and renamed test files; leaves out new test files and everything else', () => {
    const hunks = existingTestHunks([
      { filename: 'a.test.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y\n@@ -5 +5 @@\n-z' },
      { filename: 'b.test.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+new' },
      { filename: 'vitest.config.ts', status: 'modified', patch: "@@ -1 +1 @@\n-a\n+b" },
      { filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { filename: 'renamed.ts', previousFilename: 'old.spec.ts', status: 'renamed', patch: '@@ -1 +1 @@\n-p\n+q' },
      { filename: 'gone.e2e.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-it()' },
      { filename: 'big.test.ts', status: 'modified' },
    ]);
    expect(hunks.map((h) => [h.file, h.patch])).toEqual([
      ['a.test.ts', '@@ -1 +1 @@\n-x\n+y'],
      ['a.test.ts', '@@ -5 +5 @@\n-z'],
      ['renamed.ts', '@@ -1 +1 @@\n-p\n+q'],
      ['gone.e2e.ts', '@@ -1 +0,0 @@\n-it()'],
      ['big.test.ts', null],
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
