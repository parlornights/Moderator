// The CLI: Linear writes, Jev's pick and push-main through the service, the lint after an edit, and help.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { CONFIG, cli, fakeModerator, hook, repo } from './helpers.js';

const { requestId } = await import('../src/api.js');
const { repoOf } = await import('../src/pushmain.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the same Linear request on the same day carries the same UUID, so running it twice files once', () => {
  const day = new Date('2026-10-08T09:00:00Z');
  const a = requestId({ issue: 'CD-1', body: 'Released to production.' }, day);
  assert.match(a, UUID);
  assert.equal(requestId({ issue: 'CD-1', body: 'Released to production.' }, new Date('2026-10-08T23:00:00Z')), a);
  assert.notEqual(requestId({ issue: 'CD-1', body: 'Owner decided: B.' }, day), a);
  assert.notEqual(requestId({ issue: 'CD-1', body: 'Released to production.' }, new Date('2026-10-12T09:00:00Z')), a, 'the next release says it again');
});

async function setup(answer, opts, prefix = '') {
  const moderator = await fakeModerator(answer, opts);
  const r = repo({ branch: 'cd-1-x', config: { ...CONFIG, moderatorUrl: `${moderator.url}${prefix}` } });
  return { r, moderator, run: (args, input) => cli(args, { cwd: r.dir, input }) };
}

test('linear comment and issue send the text from a file or stdin, and print what was written', async () => {
  const { r, moderator, run } = await setup((route) => ({ outcome: 'done', id: route.includes('comment') ? 'c-1' : 'CD-2', url: 'https://linear.app/x' }));
  const comment = await run(['linear', 'comment', 'CD-1', '--body-file', '-'], 'Merged in #4: players can rename games.\n');
  assert.equal(comment.status, 0, comment.stderr);
  assert.equal(comment.stdout.trim(), 'done: c-1 https://linear.app/x');
  const sent = moderator.calls[0];
  assert.equal(sent.route, 'POST /tool/linear/comment');
  assert.equal(sent.auth, 'Bearer test-key');
  assert.deepEqual({ ...sent.body, id: undefined }, { id: undefined, issue: 'CD-1', body: 'Merged in #4: players can rename games.\n' });
  assert.match(sent.body.id, UUID);

  r.put('desc.md', 'From the game list a player renames a saved game.');
  const issue = await run(['linear', 'issue', '--team', 'CD', '--title', 'Players can rename a saved game', '--description-file', 'desc.md', '--project', 'Market']);
  assert.equal(issue.status, 0, issue.stderr);
  assert.deepEqual({ ...moderator.calls[1].body, id: undefined }, { id: undefined, team: 'CD', title: 'Players can rename a saved game', description: 'From the game list a player renames a saved game.', project: 'Market' });
});

test('linear update sends only what changes, with a link and labels', async () => {
  const { moderator, run } = await setup(() => ({ outcome: 'done', id: 'CD-1', url: 'u' }));
  const out = await run(['linear', 'update', 'CD-1', '--status', 'In Review', '--priority', '2', '--add-label', 'a', '--add-label', 'b', '--link', 'https://claude.ai/artifact/x', '--link-title', 'Board']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(moderator.calls[0].route, 'PATCH /tool/linear/issue/CD-1');
  assert.deepEqual(moderator.calls[0].body, { status: 'In Review', priority: 2, addLabels: ['a', 'b'], links: [{ url: 'https://claude.ai/artifact/x', title: 'Board' }] });
  assert.equal((await run(['linear', 'update', 'CD-1', '--link', 'https://x'])).status, 1);
  assert.match((await run(['linear', 'update', 'CD-1', '--priority', 'high'])).stderr, /--priority is 0 \(none\) to 4 \(low\)/);
  assert.equal(moderator.calls.length, 1);
});

test('a moderatorUrl with a path keeps it', async () => {
  const { moderator, run } = await setup(() => ({ outcome: 'done', id: 'c', url: 'u' }), undefined, '/moderator/');
  await run(['linear', 'comment', 'CD-1', '--body-file', '-'], 'x');
  assert.equal(moderator.calls[0].route, 'POST /moderator/tool/linear/comment');
});

test('a write Jev refuses, or cannot judge, is not written: exit 3 and the connector route to the owner', async () => {
  const { run } = await setup(() => ({ outcome: 'ask_owner', reason: 'jev_refused', jev: { pass: false } }));
  const out = await run(['linear', 'comment', 'CD-1', '--body-file', '-'], 'Working on it, tests are running.');
  assert.equal(out.status, 3);
  assert.match(out.stdout, /not written: Jev read it as not a product-level write.*Linear connector's own tool.*the owner approves or refuses it/);
});

test('a service error, or no service set up, is an error with its message', async () => {
  const { run } = await setup(() => ({ error: 'team ZZ not found' }), { status: 404 });
  const missing = await run(['linear', 'issue', '--team', 'ZZ', '--title', 't', '--description-file', '-'], 'd');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Moderator POST \/tool\/linear\/issue: 404 team ZZ not found/);
  const r = repo();
  const unset = await cli(['linear', 'comment', 'CD-1', '--body-file', '-'], { cwd: r.dir, input: 'x' });
  assert.equal(unset.status, 1);
  assert.match(unset.stderr, /Moderator is not set up here: moderatorUrl in moderator\.config\.json and MODERATOR_API_KEY/);
});

test("pick prints Jev's route, and unit by default when Jev does not answer", async () => {
  const { r, moderator, run } = await setup((route) =>
    route === 'POST /tool/jev/pick' ? { outcome: 'done', result: { unit: 'unit-deep', ask: true, complexity: 2.4, risky: 0.2, ambiguous: 0.8 } } : {},
  );
  r.put('brief.md', 'Move game rooms to one Durable Object per player.');
  assert.equal((await run(['pick', '--issue', 'CD-1', '--file', 'brief.md'])).stdout.trim(), 'pick: unit-deep (complexity 2.4/3, risky 0.2, ambiguous 0.8) -> ASK THE OWNER before briefing: the criteria leave a choice open');
  assert.deepEqual(moderator.calls[0].body, { issue: 'CD-1', brief: 'Move game rooms to one Durable Object per player.' });
  const down = await setup(() => ({ outcome: 'not_run', reason: 'jev_down' }));
  down.r.put('brief.md', 'x');
  assert.match((await down.run(['pick', '--file', 'brief.md'])).stdout, /^pick: unit \(Jev did not answer/);
});

test('lint after an edit: a failure is shown to the agent at once (exit 2); other files and a clean lint say nothing', async () => {
  const r = repo({ config: { ...CONFIG, lintOnEdit: 'grep -q ok {file} || { echo "lint failed: $(basename {file})"; exit 1; }' } });
  r.put("it's bad.js", 'nope');
  r.put('good.js', 'ok');
  const bad = await hook('post-edit', { tool_name: 'Write', tool_input: { file_path: `${r.dir}/it's bad.js` } }, { cwd: r.dir });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /lint failed: it's bad\.js/);
  assert.equal((await hook('post-edit', { tool_name: 'Write', tool_input: { file_path: `${r.dir}/good.js` } }, { cwd: r.dir })).status, 0);
  assert.equal((await hook('post-edit', { tool_name: 'Write', tool_input: { file_path: `${r.dir}/notes.md` } }, { cwd: r.dir })).status, 0);
});

test('help lists the commands; an unknown command is an error; a hook bug never stops the session', async () => {
  const r = repo();
  assert.match((await cli(['help'], { cwd: r.dir })).stdout, /moderator <command>[\s\S]*linear comment[\s\S]*push-main/);
  assert.equal((await cli(['nope'], { cwd: r.dir })).status, 1);
  r.put('moderator.config.json', '{ broken');
  const out = await hook('session-start', { source: 'startup' }, { cwd: r.dir });
  assert.equal(out.status, 0);
  assert.match(out.stderr, /moderator hook session-start failed: .*moderator\.config\.json/);
  assert.match(out.json.systemMessage, /^moderator hook session-start failed: moderator\.config\.json: /, 'the user sees it: the protocol is off');
  const everyCall = await hook('context-watch', { tool_name: 'Bash' }, { cwd: r.dir });
  assert.deepEqual([everyCall.status, everyCall.json], [0, null], 'a hook on every tool call does not repeat it');
});

test('owner/name comes from any form of the origin URL', () => {
  for (const url of ['https://github.com/parlornights/crooked-duke.git', 'https://github.com/parlornights/crooked-duke', 'git@github.com:parlornights/crooked-duke.git', 'ssh://git@github.com/parlornights/crooked-duke.git', 'http://local_proxy@127.0.0.1:41537/git/parlornights/crooked-duke']) {
    assert.equal(repoOf(url), 'parlornights/crooked-duke', url);
  }
  assert.equal(repoOf('nope'), null);
});

/**
 * A repo on main whose origin is a bare repository at <tmp>/owner/name.git, and a fake Moderator.
 * @param {(route: string, body: any) => unknown} answer
 * @param {{ status?: number }} [opts]
 */
async function withOrigin(answer, opts) {
  const moderator = await fakeModerator(answer, opts);
  const r = repo({ branch: 'main', config: { ...CONFIG, moderatorUrl: moderator.url, directToMain: ['.claude/', 'CLAUDE.md'] } });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'moderator-origin-'));
  after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const bare = path.join(parent, 'parlornights', 'crooked-duke.git');
  fs.mkdirSync(bare, { recursive: true });
  const remote = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: bare, encoding: 'utf8' }).trim();
  remote('init', '-q', '--bare');
  remote('symbolic-ref', 'HEAD', 'refs/heads/main');
  r.git('remote', 'add', 'origin', bare);
  r.git('push', '-q', 'origin', 'main');
  r.git('checkout', '-qb', 'harness-work');
  return { r, moderator, remote, run: () => cli(['push-main'], { cwd: r.dir }) };
}

test('a clean commit on top of origin/main goes to harness/<short sha> and Moderator moves main', async () => {
  const { r, moderator, remote, run } = await withOrigin((_route, body) => ({ outcome: 'done', branch: 'main', sha: body.sha, paths: ['CLAUDE.md'] }));
  r.put('CLAUDE.md', 'rules');
  r.git('add', '-A');
  r.git('commit', '-qm', 'rules');
  const sha = r.git('rev-parse', 'HEAD');
  const short = r.git('rev-parse', '--short', 'HEAD');
  const out = await run();
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(out.stdout, `done: main is now ${sha.slice(0, 7)}\n  CLAUDE.md\n`);
  assert.equal(remote('rev-parse', `refs/heads/harness/${short}`), sha);
  assert.equal(moderator.calls.length, 1);
  assert.equal(moderator.calls[0].route, 'POST /tool/harness/push');
  assert.equal(moderator.calls[0].auth, 'Bearer test-key');
  assert.deepEqual(moderator.calls[0].body, { repo: 'parlornights/crooked-duke', sha, branch: `harness/${short}` });
});

test("a refusal prints its reason and paths and exits 1", async () => {
  const { r, run } = await withOrigin(() => ({ outcome: 'refused', reason: "outside main's directToMain paths: these need a pull request", paths: ['src/app.ts'] }), { status: 403 });
  r.put('src/app.ts', 'x');
  r.git('add', '-A');
  r.git('commit', '-qm', 'app');
  const out = await run();
  assert.equal(out.status, 1);
  assert.equal(out.stdout, "refused: outside main's directToMain paths: these need a pull request\n  src/app.ts\n");
});

test('a dirty tree, or a commit that does not contain origin/main, is refused before anything is pushed', async () => {
  const { r, moderator, remote, run } = await withOrigin(() => ({ outcome: 'done', branch: 'main', sha: 'x', paths: [] }));
  r.put('CLAUDE.md', 'rules');
  const dirty = await run();
  assert.equal(dirty.status, 1);
  assert.match(dirty.stdout, /working tree is not clean/);
  r.git('add', '-A');
  r.git('commit', '-qm', 'rules');

  // main moves on origin: the commit is no longer a fast-forward of it.
  r.git('checkout', '-q', 'main');
  r.put('other.md', 'x');
  r.git('add', '-A');
  r.git('commit', '-qm', 'other');
  r.git('push', '-q', 'origin', 'main');
  r.git('reset', '-q', '--hard', 'HEAD~1');
  r.git('checkout', '-q', 'harness-work');
  const behind = await run();
  assert.equal(behind.status, 1);
  assert.match(behind.stdout, /HEAD does not contain origin\/main: merge origin\/main first/);
  assert.equal(remote('for-each-ref', 'refs/heads/harness'), '');
  assert.equal(moderator.calls.length, 0);
});
