// The guard refuses what no agent may do: push to main, force push, delete the repository, a unit leaving its
// branch or waiting past its cap, a subagent editing what only the main session may.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { CONFIG, hook, repo } from './helpers.js';

const { WAIT_CAP_SEC } = await import('../src/units.js');

const r = repo({ branch: 'cd-1-x', config: { ...CONFIG, protectedPaths: ['.claude/**', 'docs/papercuts.md', 'moderator.config.json'] } });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'moderator-waits-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const WAITS = path.join(TMP, 'moderator-waits');

const guard = async (tool_name, tool_input, extra = {}) => {
  const out = await hook('guard', { tool_name, tool_input, ...extra }, { cwd: r.dir, env: { TMPDIR: TMP } });
  return out.json ? out.json.hookSpecificOutput.permissionDecisionReason : 'allowed';
};
const bash = (command, agent_type, agent_id = 'u1') => guard('Bash', { command }, agent_type ? { agent_type, agent_id } : {});

test('no agent pushes to main, in any refspec form; a task branch push is untouched', async () => {
  for (const cmd of ['git push origin HEAD:main', 'git push origin main', 'git push -u origin HEAD:refs/heads/main', 'git push origin abc123:master', 'cd x && git push origin main']) {
    assert.match(await bash(cmd), /no agent pushes to main/, cmd);
  }
  assert.match(await bash('git push origin HEAD:main', 'unit'), /no agent pushes to main/);
  assert.match(await bash('git push origin HEAD:main'), /push a branch and open a pull request; harness-only changes: moderator push-main$/);
  assert.equal(await bash('git push -u origin claude/cd-1-x'), 'allowed');
  assert.equal(await bash('git push origin claude/main-menu'), 'allowed');
});

test('force push is refused, a lease is not; rm -rf at or above the repository is refused', async () => {
  assert.match(await bash('git push -f origin cd-1-x'), /force push/);
  assert.match(await bash('GIT_TRACE=1 git push --force origin cd-1-x'), /force push/);
  assert.equal(await bash('git push --force-with-lease origin cd-1-x'), 'allowed');
  for (const cmd of ['git push origin +main', 'git push origin +HEAD:main', 'git push origin +cd-1-x']) assert.match(await bash(cmd), /force push/, cmd);
  for (const cmd of ['rm -rf .', 'rm -rf /', 'rm -fr ..', 'rm -rf ../x', 'rm -rf']) assert.match(await bash(cmd), /recursive delete/, cmd);
  assert.equal(await bash('rm -rf node_modules'), 'allowed');
});

test('a unit stays on its branch, the plugin\'s units too', async () => {
  assert.match(await bash('git checkout main', 'unit'), /stay on the task branch/);
  assert.match(await bash('git checkout main', 'moderator:unit-deep'), /stay on the task branch/);
  assert.equal(await bash('git checkout main'), 'allowed');
});

test('a subagent may not kill by pattern; it kills the pid it started', async () => {
  for (const cmd of ["pkill -f 'playwright test'", 'killall node', 'cd x && pkill vite']) assert.match(await bash(cmd, 'unit'), /pattern kill/, cmd);
  assert.equal(await bash('kill 4242', 'unit'), 'allowed');
  assert.equal(await bash("pkill -f 'playwright test'"), 'allowed');
});

test('a subagent may not edit protected paths; the main session may', async () => {
  for (const rel of ['.claude/settings.json', 'docs/papercuts.md', 'moderator.config.json']) {
    assert.match(await guard('Edit', { file_path: path.join(r.dir, rel) }, { agent_type: 'unit', agent_id: 'u1' }), /unit may not edit/, rel);
    assert.match(await guard('Write', { file_path: path.join(r.dir, rel) }, { agent_type: 'reviewer', agent_id: 'r1' }), /reviewer may not edit/, rel);
    assert.equal(await guard('Edit', { file_path: path.join(r.dir, rel) }), 'allowed', rel);
  }
  assert.equal(await guard('Edit', { file_path: path.join(r.dir, 'src/a.js') }, { agent_type: 'unit', agent_id: 'u1' }), 'allowed');
});

const seed = (id, w) => {
  fs.mkdirSync(WAITS, { recursive: true });
  fs.writeFileSync(path.join(WAITS, `${id}.json`), JSON.stringify(w));
};
const waits = (id) => JSON.parse(fs.readFileSync(path.join(WAITS, `${id}.json`), 'utf8'));

test('a unit past the cap is refused a pure wait, never real work; under the cap, and for the main session, nothing is refused', async () => {
  const loop = "timeout 590 bash -c 'while kill -0 1; do sleep 15; done'";
  seed('u1', { total: WAIT_CAP_SEC - 60, since: null });
  assert.equal(await bash(loop, 'unit'), 'allowed');
  seed('u1', { total: WAIT_CAP_SEC + 1, since: null });
  assert.match(await bash(loop, 'unit'), /BLOCKED: waiting on/);
  assert.match(await bash(loop, 'moderator:unit'), /BLOCKED: waiting on/);
  assert.equal(await bash('until curl -s localhost:4173; do sleep 1; done; pnpm e2e', 'unit'), 'allowed');
  assert.equal(await bash('pnpm gate', 'unit'), 'allowed');
  assert.equal(await bash(loop), 'allowed');
  assert.equal(fs.existsSync(path.join(r.dir, '.work')), false);
});

test('waiting is measured from a wait to the unit\'s next tool call; a wait that then works starts no clock', async () => {
  seed('u3', { total: 0, since: Date.now() - 120_000 });
  await guard('Read', { file_path: 'x' }, { agent_type: 'unit', agent_id: 'u3' });
  const w = waits('u3');
  assert.ok(w.total >= 119 && w.total < 130, String(w.total));
  assert.equal(w.since, null);
  seed('u4', { total: 0, since: null });
  await bash('until curl -s localhost:4173; do sleep 1; done; pnpm e2e', 'unit', 'u4');
  assert.deepEqual(waits('u4'), { total: 0, since: null });
});
