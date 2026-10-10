// The Stop hook: one block per stop for everything left to do, never on Jev's word alone when Jev is down, and a
// turn that ends on a committed, pushed tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { CONFIG, fakeGh, fakeModerator, hook, repo, spawnUnit, toolUse, transcript } from './helpers.js';

const NOTE = 'status: in-progress\n\n## Next step\ngo\n\n## Open questions\n\n(none)\n';
const READ = toolUse('mcp__Linear__get_issue', { id: 'CD-7' });
const passing = { outcome: 'done', result: { pass: true, asking: false, checks: { asksOwner: { pass: false, p: 0.1 } } } };

/** A task branch with a committed note and a fake Moderator answering `jev` for the open-question check. */
async function setup({ jev = passing, note = NOTE, remote = true } = {}) {
  const moderator = await fakeModerator(() => jev);
  const r = repo({ branch: 'cd-7-x', config: { ...CONFIG, moderatorUrl: moderator.url }, files: { '.work/CD-7/handoff.md': note }, remote });
  // A commit the hook makes is a minute newer than the setup's, as a later turn's would be.
  const env = { GIT_COMMITTER_DATE: new Date(Date.now() + 60_000).toISOString() };
  const stop = async (input = {}) => (await hook('stop', { session_id: 's', transcript_path: input.transcript_path ?? transcript(r.scratch, [READ]), ...input }, { cwd: r.dir, env })).json;
  return { r, moderator, stop };
}

test('a turn ends on a committed, pushed tree, and its stop event is in the note commit', async () => {
  const { r, stop } = await setup();
  r.put('a.js', 'x');
  assert.equal(await stop({ stop_hook_active: true }), null);
  assert.equal(r.git('status', '--porcelain'), '');
  assert.equal(r.remoteHead(), r.git('rev-parse', 'HEAD'));
  assert.match(r.read('.work/CD-7/events.jsonl'), /"kind":"stop"/);
});

test('a stale note and an unread issue come in one block; the second stop goes through', async () => {
  const { r, stop } = await setup();
  r.put('a.js', 'x');
  const first = await stop({ transcript_path: transcript(r.scratch, []) });
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /update \.work\/CD-7\/handoff\.md \(code commits are newer than the last committed note\)/);
  assert.match(first.reason, /CD-7 was not read on Linear/);
  assert.equal(await stop({ stop_hook_active: true }), null);
});

test('a note-only change is held for 30 minutes after a push; code goes out at once; nothing new writes nothing', async () => {
  const { r, stop } = await setup();
  const before = r.remoteHead();
  await stop({ stop_hook_active: true });
  assert.equal(r.remoteHead(), before, 'a turn that only read pushes nothing');
  r.put('.work/CD-7/handoff.md', `${NOTE}\nmore\n`);
  await stop({ stop_hook_active: true });
  assert.equal(r.remoteHead(), before, 'the note waits');
  assert.equal(r.git('status', '--porcelain'), '');
  r.put('code.js', 'x');
  await stop({ stop_hook_active: true });
  assert.equal(r.remoteHead(), r.git('rev-parse', 'HEAD'));
});

test('open questions are judged by Jev: not whole, or not repeated, holds the stop with the shape to use', async () => {
  const note = `${NOTE.replace('(none)', '- Q1: Which runner?\n  - Recommend: the fast one')}`;
  const { moderator, stop } = await setup({
    note,
    jev: { outcome: 'done', result: { pass: false, asking: false, checks: { wellFormed: { pass: false, p: 0.1 }, repeated: { pass: false, p: 0.2 }, asksOwner: { pass: false, p: 0 } } } },
  });
  const out = await stop({ last_assistant_message: 'Merged #4.' });
  assert.match(out.reason, /not each one question with two or more options/);
  assert.match(out.reason, /end your message with every open question in full/);
  const call = moderator.calls.find((c) => c.route === 'POST /tool/jev/open-questions');
  assert.equal(call.auth, 'Bearer test-key');
  assert.deepEqual(call.body, { open_questions: '- Q1: Which runner?\n  - Recommend: the fast one', last_message: 'Merged #4.' });
});

test('a turn that asks the owner needs its question in the note, and waits on nothing else', async () => {
  const { r, moderator, stop } = await setup({ jev: { outcome: 'done', result: { pass: true, asking: true, checks: { asksOwner: { pass: true, p: 0.9 } } } } });
  r.put('a.js', 'x');
  const out = await stop({ last_assistant_message: 'Which icon, star or grid?', transcript_path: transcript(r.scratch, []) });
  assert.match(out.reason, /asks the owner, but the handoff note has no open question/);
  assert.doesNotMatch(out.reason, /handoff\.md \(|was not read/);
  assert.equal(moderator.calls[0].body.open_questions, '', '"(none)" is no question');
});

test('Jev not answering never blocks: the stop says the check did not run', async () => {
  const { stop } = await setup({ jev: { outcome: 'not_run', reason: 'jev_down' } });
  const out = await stop({ last_assistant_message: 'Done.' });
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /open-question check did not run/);
});

test('a published artifact not on a note line with an issue id holds the stop', async () => {
  const { r, stop } = await setup();
  fs.appendFileSync(path.join(r.dir, '.work/CD-7/events.jsonl'), JSON.stringify({ kind: 'artifact', url: 'https://claude.ai/artifact/abc' }) + '\n');
  assert.match((await stop()).reason, /published but not tied to a Linear issue: https:\/\/claude\.ai\/artifact\/abc/);
});

test('past the hand-over share, the stop is held until the note changes', async () => {
  const { r, stop } = await setup();
  process.chdir(r.dir);
  const { noteHash } = await import('../src/handoff.js');
  fs.appendFileSync(path.join(r.dir, '.work/CD-7/events.jsonl'), JSON.stringify({ kind: 'context-high', session: 's', tokens: 800_000, note: noteHash() }) + '\n');
  assert.match((await stop()).reason, /passed 80% of the window/);
  assert.equal(await stop({ stop_hook_active: true }), null);
});

test('a running unit without a check-in holds the stop once; one in this checkout keeps the index untouched', async () => {
  const { r, stop } = await setup();
  r.put('a.js', 'x');
  const t = transcript(r.scratch, [READ, ...spawnUnit('t1', 'aaa111')]);
  fs.mkdirSync(path.join(r.scratch, 'session', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(r.scratch, 'session', 'subagents', 'agent-aaa111.jsonl'), '{}\n');
  const first = await stop({ transcript_path: t });
  assert.match(first.reason, /no check-in is armed/);
  assert.doesNotMatch(r.git('log', '--format=%s'), /checkpoint/);
  assert.equal(await stop({ transcript_path: t, stop_hook_active: true }), null);
});

test('a unit in its own worktree does not stop the checkpoint, and its todos join the note check', async () => {
  const { r, stop } = await setup();
  r.put('a.js', 'x');
  const t = transcript(r.scratch, [READ, ...spawnUnit('t1', 'aaa111')]);
  const sub = path.join(r.scratch, 'session', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-aaa111.jsonl'), '{}\n');
  fs.writeFileSync(path.join(sub, 'agent-aaa111.meta.json'), JSON.stringify({ worktreePath: '/elsewhere' }));
  const out = await stop({ transcript_path: t });
  assert.match(out.reason, /no check-in is armed/);
  assert.match(out.reason, /handoff\.md/);
  assert.match(r.git('log', '--format=%s'), /wip\(CD-7\): checkpoint/);
});

test('without a readable transcript the hook falls back to running.json', async () => {
  const { r, stop } = await setup();
  r.put('.work/CD-7/running.json', JSON.stringify({ u1: { agent_type: 'unit', started: new Date().toISOString(), session: 's' } }));
  r.put('a.js', 'x');
  await stop({ transcript_path: path.join(r.scratch, 'missing.jsonl') });
  assert.doesNotMatch(r.git('log', '--format=%s'), /checkpoint/);
});

test("running.json entries of another session, or older than a day, are gone units: they hold nothing", async () => {
  const { r, stop } = await setup();
  const dayAgo = new Date(Date.now() - 25 * 3600_000).toISOString();
  r.put('.work/CD-7/running.json', JSON.stringify({ u0: { agent_type: 'unit', started: new Date().toISOString(), session: 'earlier' }, u1: { agent_type: 'unit', started: dayAgo, session: 's' }, u2: { agent_type: 'unit' } }));
  r.put('a.js', 'x');
  await stop({ transcript_path: path.join(r.scratch, 'missing.jsonl'), stop_hook_active: true });
  assert.match(r.git('log', '--format=%s'), /wip\(CD-7\): checkpoint/);
});

test('in the middle of a merge it commits and pushes nothing, so no conflict marker leaves the machine', async () => {
  const { r, stop } = await setup();
  r.put('a.js', 'base\n');
  r.git('add', '-A');
  r.git('commit', '-qm', 'a');
  r.git('checkout', '-q', '-b', 'other');
  r.put('a.js', 'theirs\n');
  r.git('commit', '-qam', 'theirs');
  r.git('checkout', '-q', 'cd-7-x');
  r.put('a.js', 'ours\n');
  r.git('commit', '-qam', 'ours');
  assert.throws(() => r.git('merge', '-q', 'other'));
  const head = r.git('rev-parse', 'HEAD');
  const pushed = r.remoteHead();
  assert.match((await stop({ transcript_path: transcript(r.scratch, []) })).reason, /CD-7 was not read/, 'the checks still run');
  assert.equal(await stop({ stop_hook_active: true }), null);
  assert.equal(r.git('rev-parse', 'HEAD'), head);
  assert.equal(r.remoteHead(), pushed);
  assert.match(r.git('status', '--porcelain'), /^UU a\.js/m);
});

test('on main it does nothing', async () => {
  const r = repo({ branch: 'main', files: { 'a.js': 'x' } });
  r.put('b.js', 'y');
  assert.equal((await hook('stop', { session_id: 's' }, { cwd: r.dir })).json, null);
  assert.match(r.git('status', '--porcelain'), /b\.js/);
});

/** A branch named without an issue, pushed to a bare remote whose fetch URL is on GitHub, so its PR is looked up. */
function unnamedBranch() {
  const r = repo({ branch: 'claude/tidy-up', files: { 'a.js': 'x' }, remote: true });
  const bare = r.git('remote', 'get-url', 'origin');
  r.git('remote', 'set-url', 'origin', 'https://github.com/acme/app');
  r.git('remote', 'set-url', '--push', 'origin', bare);
  return r;
}
const PRS = 'repos/acme/app/pulls?state=open&head=acme%3Aclaude%2Ftidy-up';

test("a branch that names no issue takes it from its open PR's title, and the turn ends committed and pushed", async () => {
  const r = unnamedBranch();
  const env = fakeGh(r.scratch, { [PRS]: [{ number: 4, title: 'Tidy up (CD-9)', html_url: 'https://github.com/acme/app/pull/4', draft: false }] });
  r.put('b.js', 'y');
  assert.equal((await hook('stop', { session_id: 's', stop_hook_active: true }, { cwd: r.dir, env })).json, null);
  assert.match(r.git('log', '--format=%s'), /wip\(CD-9\): checkpoint/);
  assert.equal(r.git('config', '--get', 'branch.claude/tidy-up.moderatorIssue'), 'CD-9');
  assert.equal(r.remoteHead(), r.git('rev-parse', 'HEAD'));
  assert.match(r.read('.work/CD-9/events.jsonl'), /"kind":"stop"/);
});

test('with no issue in the branch or a PR title, the stop is held once per session to say so, and nothing is committed', async () => {
  const r = unnamedBranch();
  const env = fakeGh(r.scratch, { [PRS]: [{ number: 4, title: 'Tidy up', html_url: 'https://github.com/acme/app/pull/4', draft: false }] });
  r.put('b.js', 'y');
  const stop = async (input) => (await hook('stop', input, { cwd: r.dir, env })).json;
  const first = await stop({ session_id: 's' });
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /This task has no issue: neither the branch "claude\/tidy-up" nor an open PR's title names one/);
  assert.equal(await stop({ session_id: 's', stop_hook_active: true }), null);
  assert.equal(await stop({ session_id: 's' }), null, 'once per session');
  assert.equal((await stop({ session_id: 's2' })).decision, 'block');
  assert.match(r.git('status', '--porcelain'), /b\.js/);
  assert.equal(fs.existsSync(path.join(r.dir, '.work')), false);
});
