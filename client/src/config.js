// moderator.config.json at the repository root: the repo's own rules. Read on use, validated, never written.

import fs from 'node:fs';
import path from 'node:path';

import picomatch from 'picomatch';
import { z } from 'zod';

import { root } from './git.js';

export const CONFIG_FILE = 'moderator.config.json';

const regex = z.string().min(1).refine((s) => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}, 'not a valid regular expression');

const check = z.strictObject({
  /** files: lintable files changed; packages: a workspace package changed; rule: a rule names it; always. */
  when: z.enum(['files', 'packages', 'rule', 'always']),
  /** {files}: the changed lintable files, quoted; {filters}: pnpm's `-r`, or `--filter "...<pkg>"` per changed package. */
  cmd: z.string().min(1),
  order: z.number().default(50),
  timeoutSec: z.number().positive().default(900),
  skipAfterFailure: z.boolean().default(false),
});

const schema = z.strictObject({
  /** A Linear issue id of this workspace, matched case-insensitively in the branch name. */
  issuePattern: regex,
  /** The Moderator service the CLI and hooks call; the key is MODERATOR_API_KEY in the environment. */
  moderatorUrl: z.url().optional(),
  base: z.string().default('origin/main'),
  ignore: z.array(z.string()).default([]),
  /** A change here runs every check for every package. */
  global: z.array(z.string()).default([]),
  lintExtensions: z.array(z.string()).default([]),
  /** Run on each edited file with a lint extension; {file} is its path. A failure is shown to the agent at once. */
  lintOnEdit: z.string().optional(),
  checks: z.record(z.string(), check).default({}),
  rules: z.array(z.strictObject({ name: z.string(), match: z.array(z.string()).min(1), checks: z.array(z.string()) })).default([]),
  risk: z
    .strictObject({
      highPaths: z.array(z.string()).default([]),
      testGlobs: z.array(z.string()).default(['**/*.test.*', '**/*.spec.*', '**/__tests__/**']),
      linesHigh: z.number().default(400),
      filesHigh: z.number().default(15),
      srcLinesNeedingTests: z.number().default(30),
    })
    .prefault({}),
  /** Only the main session may edit these; a subagent puts its suggestion in its hand-back instead. */
  protectedPaths: z.array(z.string()).default([]),
  papercuts: z.string().default('docs/papercuts.md'),
  /** Docs every session reads in full right after CLAUDE.md, at start and after a compaction. */
  readAtStart: z.array(z.strictObject({ path: z.string(), why: z.string() })).default([]),
  context: z.strictObject({ window: z.number().positive().default(1_000_000), handoffShare: z.number().gt(0).lt(1).default(0.7) }).prefault({}),
});

/** @typedef {z.infer<typeof schema>} Config */

/** @type {Map<string, Config | null>} */
const cache = new Map();

/** The repo's config, or null when it has none. Throws when the file is not valid. */
export function config() {
  const r = root();
  if (cache.has(r)) return /** @type {Config | null} */ (cache.get(r));
  const file = path.join(r, CONFIG_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    cache.set(r, null);
    return null;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${CONFIG_FILE}: ${e instanceof Error ? e.message : e}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${CONFIG_FILE}: ${z.prettifyError(parsed.error)}`);
  cache.set(r, parsed.data);
  return parsed.data;
}

/** The config, or an error naming the file a command needs. */
export function requireConfig() {
  const c = config();
  if (!c) throw new Error(`no ${CONFIG_FILE} at ${root()}`);
  return c;
}

/**
 * One matcher for a list of repo-relative globs.
 * @param {string[]} globs
 * @returns {(file: string) => boolean}
 */
export function matcher(globs) {
  return globs.length ? picomatch(globs, { dot: true }) : () => false;
}
