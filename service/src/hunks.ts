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
  '**/vite.config.*',
  '**/package.json',
  '.github/workflows/**',
];

/** Test files proper; a new one only adds coverage. A new config, mock or fixture can change what runs, so it is judged. */
const isNewTestFile = picomatch(['**/*.test.*', '**/*.spec.*', '**/__tests__/**'], { dot: true });

export const isTestPath = picomatch(TEST_GLOBS, { dot: true });

export interface ChangedFile {
  filename: string;
  status: string;
  previousFilename?: string;
  patch?: string;
  /** Blob sha, used only when GitHub sends no patch (binary or too large). */
  sha?: string;
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

/** The hunks of a PR that touch tests, fixtures, mocks or test config. New test files are left out. */
export function existingTestHunks(files: ChangedFile[]): Hunk[] {
  return files
    .filter((f) => isTestPath(f.previousFilename ?? f.filename) && !(f.status === 'added' && isNewTestFile(f.filename)))
    .flatMap((f): Hunk[] => (f.patch ? splitPatch(f.patch).map((patch) => ({ file: f.filename, status: f.status, patch })) : [{ file: f.filename, status: f.status, patch: null }]));
}

/** Identifies a hunk by its file and changed lines, not its line numbers, so it is recognised on a later commit. */
export async function hunkHash(h: Hunk): Promise<string> {
  const body = (h.patch ?? '').split('\n').filter((l) => !l.startsWith('@@')).join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${h.file}\n${body}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A fingerprint of a PR's own diff: every file with its status and changed lines, without line numbers. Merging the
 * base branch into the PR leaves it as it was; any change to the PR's own changes alters it.
 */
export async function diffHash(files: ChangedFile[]): Promise<string> {
  const text = [...files]
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((f) => `${f.status} ${f.previousFilename ?? ''} ${f.filename} ${f.sha ?? ''}\n${(f.patch ?? '').split('\n').filter((l) => !l.startsWith('@@')).join('\n')}`)
    .join('\n\0\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
