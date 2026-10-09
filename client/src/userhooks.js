// The repo's hooks, copied into the user's settings. Claude Code reads a repo's .claude/settings.json only while the
// session's project is that repo: once a second repository joins the session, the project becomes their parent
// directory and every repo hook goes silent for the rest of it (CrookedDuke, 8 Oct). User-level hooks fire wherever the
// session works, so `moderator user-hooks`, run by the cloud environment's setup script, copies the repo's hooks there,
// each one skipped while the repo's own copy runs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = '# moderator-user-hook';

/** @param {string} s */
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** One exec-form argument as a double-quoted shell word, with `${CLAUDE_PROJECT_DIR}` left to the shell. @param {string} a */
const word = (a) => `"${a.split('${CLAUDE_PROJECT_DIR}').map((p) => p.replace(/[\\"$`]/g, '\\$&')).join('${CLAUDE_PROJECT_DIR}')}"`;

const MODERATOR_HOOK = /\bmoderator(?:\.js)?['"]?\s+['"]?hook['"]?\s+['"]?[\w-]+['"]?/;

/** @param {string} repo */
const marker = (repo) => `${MARK} ${quote(repo)}`;

/**
 * One repo hook as a shell command that runs from anywhere: skipped while the session's project is the repo (its own
 * copy runs then), otherwise run as written with CLAUDE_PROJECT_DIR set to the repo, `moderator hook` given `--repo`.
 * @param {{ command: string, args?: string[] }} h
 * @param {string} repo
 */
export function userCommand(h, repo) {
  if (/[\n']/.test(repo)) throw new Error(`a repository path with a quote or a newline cannot be copied: ${JSON.stringify(repo)}`);
  let run = h.args ? [word(h.command), ...h.args.map(word)].join(' ') : h.command;
  if (MODERATOR_HOOK.test(run)) run = run.replace(MODERATOR_HOOK, (m) => `${m} --repo ${quote(repo)}`);
  const project = `"$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd -P)"`;
  return `if [ ${project} = ${quote(repo)} ]; then :; else CLAUDE_PROJECT_DIR=${quote(repo)}; export CLAUDE_PROJECT_DIR\n${run}\nfi ${marker(repo)}`;
}

/**
 * The user-level hooks for `repo`: its own, rewritten by userCommand.
 * @param {Record<string, any[]>} repoHooks
 * @param {string} repo
 * @returns {Record<string, any[]>}
 */
export function userHooks(repoHooks, repo) {
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const [event, entries] of Object.entries(repoHooks)) {
    out[event] = entries.map((e) => ({
      ...e,
      hooks: e.hooks.map((/** @type {any} */ h) => {
        const { args: _args, ...rest } = h;
        return { ...rest, command: userCommand(h, repo) };
      }),
    }));
  }
  return out;
}

/**
 * Write the repo's hooks into the user's settings, replacing an earlier copy for the same repo and keeping every other
 * setting and hook. A settings file that cannot be parsed is left alone. Returns how many hooks were copied.
 * @param {{ repo: string, home?: string }} opts
 */
export function installUserHooks({ repo, home = os.homedir() }) {
  let repoHooks = {};
  try {
    repoHooks = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8')).hooks ?? {};
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
  }
  const file = path.join(home, '.claude', 'settings.json');
  /** @type {any} */
  let settings = {};
  let before = null;
  try {
    before = fs.readFileSync(file, 'utf8');
    settings = JSON.parse(before);
  } catch (e) {
    if (before !== null) throw new Error(`${file} is not JSON; left as it is (${e instanceof Error ? e.message : e})`);
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
  }
  const ours = (/** @type {any} */ h) => typeof h.command === 'string' && h.command.endsWith(marker(repo));
  /** @type {Record<string, any[]>} */
  const hooks = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = /** @type {any[]} */ (entries).map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((/** @type {any} */ h) => !ours(h)) })).filter((e) => e.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  const copied = userHooks(repoHooks, repo);
  for (const [event, entries] of Object.entries(copied)) hooks[event] = [...(hooks[event] ?? []), ...entries];
  const next = JSON.stringify({ ...settings, hooks }, null, 2) + '\n';
  // An unchanged file is not rewritten (Claude Code reloads settings on every write), and a write is a rename, so a
  // session reading it never sees half a file.
  if (before !== next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
  }
  return Object.values(copied).reduce((n, entries) => n + entries.reduce((m, e) => m + e.hooks.length, 0), 0);
}
