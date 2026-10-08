// The CLI: Linear writes and Jev's pick through the service, the lint after an edit, and help.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONFIG, cli, fakeModerator, hook, repo } from './helpers.js';

const { requestId } = await import('../src/api.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the same Linear request always carries the same UUID, so running it twice files once', () => {
  const a = requestId({ issue: 'CD-1', body: 'Owner decided: A.' });
  assert.match(a, UUID);
  assert.equal(requestId({ issue: 'CD-1', body: 'Owner decided: A.' }), a);
  assert.notEqual(requestId({ issue: 'CD-1', body: 'Owner decided: B.' }), a);
});

async function setup(answer, opts) {
  const moderator = await fakeModerator(answer, opts);
  const r = repo({ branch: 'cd-1-x', config: { ...CONFIG, moderatorUrl: moderator.url } });
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
  assert.match((await cli(['help'], { cwd: r.dir })).stdout, /moderator <command>[\s\S]*linear comment/);
  assert.equal((await cli(['nope'], { cwd: r.dir })).status, 1);
  r.put('moderator.config.json', '{ broken');
  const out = await hook('session-start', { source: 'startup' }, { cwd: r.dir });
  assert.equal(out.status, 0);
  assert.match(out.stderr, /moderator hook session-start failed: .*moderator\.config\.json/);
});
