import picomatch from 'picomatch';

/** Test files are known by name alone: a `.test.`, `.spec.` or `.e2e.` infix (owner, 8 Oct). */
export const TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/*.e2e.*'];

export const isTestPath = picomatch(TEST_GLOBS, { dot: true });

export interface ChangedFile {
  filename: string;
  status: string;
  previousFilename?: string;
  patch?: string;
  /** Blob sha, used only when GitHub sends no patch (a pure rename, binary or too large). */
  sha?: string;
  /**
   * With no patch, the blob sha of the file's old path at the merge base, null when it was not there: the head blob alone
   * does not say what the PR changed.
   */
  baseSha?: string | null;
}

export interface Hunk {
  file: string;
  status: string;
  /** The hunk as GitHub shows it, or null when GitHub sends no patch (a pure rename, binary or too large). */
  patch: string | null;
  /** Kept on a hunk with no patch, so the file still has a fingerprint. */
  previousFilename?: string;
  sha?: string;
  baseSha?: string | null;
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

/** The hunks of a PR that change, rename or remove a test file that already exists. A new test file only adds coverage. */
export function existingTestHunks(files: ChangedFile[]): Hunk[] {
  return files
    .filter((f) => f.status !== 'added' && isTestPath(f.previousFilename ?? f.filename))
    .flatMap((f): Hunk[] =>
      f.patch
        ? splitPatch(f.patch).map((patch) => ({ file: f.filename, status: f.status, patch }))
        : [{ file: f.filename, status: f.status, patch: null, previousFilename: f.previousFilename, sha: f.sha, baseSha: f.baseSha }],
    );
}

/** A file with no patch, by what is known of it; a base blob that was not there reads `(none)`. */
const noPatch = (status: string, previousFilename: string | undefined, file: string, sha: string | undefined, baseSha: string | null | undefined) =>
  `${status} ${previousFilename ?? ''} ${file} ${sha ?? ''} ${baseSha === null ? '(none)' : (baseSha ?? '')}`;

/**
 * Identifies a hunk by its file and changed lines, not its line numbers, so it is recognised on a later commit. A hunk
 * GitHub sends no patch for is identified by its status, previous name, and blob sha at the merge base and at the head.
 */
export async function hunkHash(h: Hunk): Promise<string> {
  const body = h.patch === null ? noPatch(h.status, h.previousFilename, h.file, h.sha, h.baseSha) : h.patch.split('\n').filter((l) => !l.startsWith('@@')).join('\n');
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
    .map((f) =>
      f.patch
        ? `${f.status} ${f.previousFilename ?? ''} ${f.filename} ${f.sha ?? ''}\n${f.patch.split('\n').filter((l) => !l.startsWith('@@')).join('\n')}`
        : `${noPatch(f.status, f.previousFilename, f.filename, f.sha, f.baseSha)}\n`,
    )
    .join('\n\0\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
