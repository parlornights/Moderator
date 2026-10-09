// User-level hooks: the repo's hooks copied to the user's settings, so they keep firing once the session's project
// is no longer the repo (a second repository joined the session), and skipped while the repo's own copy runs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { BIN, env, hook, repo } from './helpers.js';

const { installUserHooks, userCommand } = await import('../src/userhooks.js');

const REPO_HOOKS = {
  SessionStart: [
    { matcher: 'startup|resume', hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR"/infra/net.sh', timeout: 120 }] },
    {
      matcher: 'startup|resume|clear|compact|fork',
      hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js', 'hook', 'session-start'], timeout: 60 }],
    },
  ],
};

const sh = (/** @type {string} */ cmd, /** @type {Record<string, string>} */ e) => execFileSync('bash', ['-c', cmd], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...e } });

test('a copied hook runs from anywhere with the repo as its project, and never while the project is the repo', () => {
  const r = repo();
  r.put('infra/net.sh', 'echo "net ran for $CLAUDE_PROJECT_DIR"\n');
  const cmd = userCommand({ command: 'bash "$CLAUDE_PROJECT_DIR"/infra/net.sh' }, r.dir);
  assert.equal(sh(cmd, { CLAUDE_PROJECT_DIR: '/home/user' }).trim(), `net ran for ${r.dir}`);
  assert.equal(sh(cmd, { CLAUDE_PROJECT_DIR: r.dir }), '');
  const link = `${r.dir}-link`;
  fs.symlinkSync(r.dir, link);
  assert.equal(sh(cmd, { CLAUDE_PROJECT_DIR: link }), '', 'the same repo through a symlink is the same project');
  fs.rmSync(link);
});

test('a compound command stays whole: skipped whole in the repo, run whole elsewhere, with its exit code', () => {
  const r = repo();
  for (const command of ['echo a && echo b', 'echo a; echo b']) {
    const cmd = userCommand({ command }, r.dir);
    assert.equal(sh(cmd, { CLAUDE_PROJECT_DIR: r.dir }), '', command);
    assert.equal(sh(cmd, { CLAUDE_PROJECT_DIR: '/home/user' }), 'a\nb\n', command);
  }
  assert.throws(() => sh(userCommand({ command: 'exit 2' }, r.dir), { CLAUDE_PROJECT_DIR: '/home/user' }), (e) => /** @type {any} */ (e).status === 2);
});

test('moderator hooks get --repo in exec and shell form; arguments keep the project dir to the shell', () => {
  const r = repo();
  const exec = userCommand({ command: 'node', args: ['${CLAUDE_PROJECT_DIR}/x/bin/moderator.js', 'hook', 'stop'] }, r.dir);
  assert.ok(exec.includes(`"node" "\${CLAUDE_PROJECT_DIR}/x/bin/moderator.js" "hook" "stop" --repo '${r.dir}'`), exec);
  const shell = userCommand({ command: 'pnpm exec moderator hook pre-compact' }, r.dir);
  assert.ok(shell.includes(`moderator hook pre-compact --repo '${r.dir}'`), shell);
  assert.throws(() => userCommand({ command: 'x' }, "/tmp/it's"), /quote or a newline/);
});

test('installing keeps every other setting and hook, and replaces only its own earlier copy', () => {
  const r = repo();
  r.put('.claude/settings.json', JSON.stringify({ hooks: REPO_HOOKS }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moderator-home-'));
  const other = { type: 'command', command: '~/.claude/stop-hook-git-check.sh' };
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [other] }] } }));
  installUserHooks({ repo: r.dir, home });
  installUserHooks({ repo: r.dir, home });
  const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(s.model, 'x');
  assert.deepEqual(s.hooks.Stop, [{ hooks: [other] }]);
  assert.deepEqual(s.hooks.SessionStart.map((/** @type {any} */ e) => e.matcher), ['startup|resume', 'startup|resume|clear|compact|fork']);
  assert.ok(s.hooks.SessionStart.every((/** @type {any} */ e) => e.hooks.every((/** @type {any} */ h) => !h.args && h.command.endsWith(`# moderator-user-hook '${r.dir}'`))));
  assert.deepEqual(s.hooks.SessionStart.map((/** @type {any} */ e) => e.hooks[0].timeout), [120, 60]);
  r.put('.claude/settings.json', JSON.stringify({ permissions: {} }));
  assert.equal(installUserHooks({ repo: r.dir, home }), 0);
  const left = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(left.hooks, { Stop: [{ hooks: [other] }] }, 'a repo without hooks leaves no copy behind');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a settings file that is not JSON is left exactly as it is', () => {
  const r = repo();
  r.put('.claude/settings.json', JSON.stringify({ hooks: REPO_HOOKS }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moderator-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), '{ "model": "x", // mine\n}');
  assert.throws(() => installUserHooks({ repo: r.dir, home }), /is not JSON; left as it is/);
  assert.equal(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'), '{ "model": "x", // mine\n}');
  fs.rmSync(home, { recursive: true, force: true });
});

test('`moderator user-hooks` writes them for the repo it runs in', () => {
  const r = repo();
  r.put('.claude/settings.json', JSON.stringify({ hooks: REPO_HOOKS }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moderator-home-'));
  const out = execFileSync('node', [BIN, 'user-hooks'], { cwd: r.dir, encoding: 'utf8', env: env({ HOME: home }) });
  assert.match(out, /2 user-level hooks for/);
  assert.ok(fs.existsSync(path.join(home, '.claude/settings.json')));
  fs.rmSync(home, { recursive: true, force: true });
});

test("with --repo, a hook run outside any configured repo works on that repo's task, and the guard still refuses a push to main", async () => {
  const r = repo({ branch: 'cd-7-x' });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'moderator-elsewhere-'));
  r.put('t.jsonl', JSON.stringify({ type: 'user', message: { content: 'said before compaction' } }) + '\n');
  const res = await hook('session-start', { source: 'compact', session_id: 's', cwd: elsewhere, transcript_path: `${r.dir}/t.jsonl` }, { cwd: elsewhere, args: ['--repo', r.dir] });
  assert.match(res.json.hookSpecificOutput.additionalContext, /Handoff: read \.work\/CD-7\/handoff\.md/);
  assert.match(r.read('.work/CD-7/handoff.md'), /U: said before compaction/);
  const push = { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:main' } };
  assert.match(JSON.stringify((await hook('guard', push, { cwd: elsewhere, args: ['--repo', r.dir] })).json), /no agent pushes to main/);
  fs.rmSync(elsewhere, { recursive: true, force: true });
});
