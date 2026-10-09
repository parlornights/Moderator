import { describe, expect, it } from 'vitest';

import { diffHash, existingTestHunks, hunkHash, isTestPath, splitPatch } from '../src/hunks';

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
      { filename: 'big.test.ts', status: 'modified', sha: 'blob1' },
      { filename: 'new/moved.test.ts', previousFilename: 'moved.test.ts', status: 'renamed', sha: 'blob2' },
    ]);
    expect(hunks.map((h) => [h.file, h.patch])).toEqual([
      ['a.test.ts', '@@ -1 +1 @@\n-x\n+y'],
      ['a.test.ts', '@@ -5 +5 @@\n-z'],
      ['renamed.ts', '@@ -1 +1 @@\n-p\n+q'],
      ['gone.e2e.ts', '@@ -1 +0,0 @@\n-it()'],
      ['big.test.ts', null],
      ['new/moved.test.ts', null],
    ]);
    expect(hunks.at(-1)).toEqual({ file: 'new/moved.test.ts', status: 'renamed', patch: null, previousFilename: 'moved.test.ts', sha: 'blob2' });
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

describe('hunkHash', () => {
  it('fingerprints a patched hunk by its file and changed lines, as before', async () => {
    const h = { file: 'a.test.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' };
    expect(await hunkHash(h)).toBe('fbd7ff79ad2cc9b4cc40adbb0b132fc8f58e6d3cd567c055b65c74fa3175c610');
    expect(await hunkHash({ ...h, patch: '@@ -40 +40 @@\n-x\n+y', sha: 'ignored' })).toBe(await hunkHash(h));
  });

  it('fingerprints a hunk without a patch by its status, previous name, file and blob sha', async () => {
    const h = { file: 'new/a.test.ts', status: 'renamed', patch: null, previousFilename: 'a.test.ts', sha: 'blob1' };
    const base = await hunkHash(h);
    expect(await hunkHash({ ...h })).toBe(base);
    expect(await hunkHash({ ...h, sha: 'blob2' })).not.toBe(base);
    expect(await hunkHash({ ...h, status: 'modified' })).not.toBe(base);
    expect(await hunkHash({ ...h, previousFilename: 'b.test.ts' })).not.toBe(base);
    expect(await hunkHash({ ...h, file: 'new/b.test.ts' })).not.toBe(base);
  });
});
