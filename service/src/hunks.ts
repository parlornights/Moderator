import picomatch from 'picomatch';

/** Paths that hold tests, their fixtures, snapshots, mocks, helpers and the config that decides what runs. */
export const TEST_GLOBS = [
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/e2e/**',
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/__snapshots__/**',
  '**/*.snap',
  '**/*-snapshots/**',
  '**/mock/**',
  '**/mocks/**',
  '**/__mocks__/**',
  '**/test-support/**',
  '**/test-utils/**',
  '**/vitest.config.*',
  '**/vitest.setup.*',
  '**/vitest.workspace.*',
  '**/jest.config.*',
  '**/jest.setup.*',
  '**/playwright.config.*',
];

export const isTestPath = picomatch(TEST_GLOBS, { dot: true });

export interface ChangedFile {
  filename: string;
  status: string;
  previousFilename?: string;
  patch?: string;
}

export interface Hunk {
  file: string;
  status: string;
  /** The hunk as GitHub shows it, or null when GitHub sends no patch (binary or too large). */
  patch: string | null;
}

/** A unified diff patch split at its `@@` headers. */
export function splitPatch(patch: string): string[] {
  const hunks: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') || hunks.length === 0) hunks.push(line);
    else hunks[hunks.length - 1] += `\n${line}`;
  }
  return hunks;
}

/** The hunks of a PR that touch a test file that already exists on the base branch. New test files are left out. */
export function existingTestHunks(files: ChangedFile[]): Hunk[] {
  return files
    .filter((f) => f.status !== 'added' && isTestPath(f.previousFilename ?? f.filename))
    .flatMap((f): Hunk[] => (f.patch ? splitPatch(f.patch).map((patch) => ({ file: f.filename, status: f.status, patch })) : [{ file: f.filename, status: f.status, patch: null }]));
}
