// The handoff note: its auto block carries the last turns in full; it is stale until the agent's part is committed
// after the code; a published artifact is tied to an issue on one line; the issue is read on Linear each session.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hook, repo, toolUse, transcript } from './helpers.js';

const { linearGaps, staleness, unlinkedArtifacts, writeHandoff } = await import('../src/handoff.js');
const { turns } = await import('../src/transcript.js');

const LONG = 'x'.repeat(600);
const rec = (type, content, extra = {}) => ({ type, message: { content }, ...extra });

test('turns keep their full text and drop tool calls, tool-only turns, reminders and sidechains', () => {
  const r = repo();
  const t = transcript(r.scratch, [
    rec('user', 'first question'),
    rec('assistant', [{ type: 'text', text: `answer ${LONG}` }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
    rec('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: '/a' } }]),
    rec('user', [{ type: 'tool_result', content: 'tool output' }]),
    rec('user', 'note <system-reminder>boilerplate</system-reminder> kept <!-- harness guidance --> too'),
    rec('assistant', 'from a subagent', { isSidechain: true }),
    rec('assistant', 'line one\nline two'),
    rec('user', "shell $'x' and $& and $` and $$ stay as typed"),
  ]);
  const all = turns(t);
  assert.deepEqual(all.map((x) => x.role), ['U', 'A', 'U', 'A', 'U']);
  assert.equal(all[1].text, `answer ${LONG}`);
  assert.doesNotMatch(JSON.stringify(all), /Bash|Read|tool output|boilerplate|harness guidance|from a subagent/);
  assert.equal(all[2].text, 'note  kept  too');
  assert.equal(turns(t, 2).length, 2);

  process.chdir(r.dir);
  writeHandoff({ transcriptPath: t, source: 'test' });
  const note = r.read('.work/CD-1/handoff.md');
  assert.ok(note.includes(`  A: answer ${LONG}`));
  assert.ok(note.includes('  A: line one\n     line two'));
  assert.ok(note.includes("U: shell $'x' and $& and $` and $$ stay as typed"));
  writeHandoff({ transcriptPath: t, source: 'again' });
  assert.equal(r.read('.work/CD-1/handoff.md').split('## Goal').length, 2, 'the auto block is replaced, not appended');
});

test('stale: no note, an empty Next step, or code committed after the note', () => {
  const r = repo({ branch: 'cd-2-x' });
  process.chdir(r.dir);
  assert.equal(staleness(), 'there is no handoff note yet');
  r.put('.work/CD-2/handoff.md', 'status: in-progress\n\n## Next step\n\n(the single next action)\n\n## Open questions\n');
  assert.equal(staleness(), '"Next step" is empty');
  // %ct, the committer date, orders the commits.
  const commitAt = (date, msg) => {
    process.env.GIT_COMMITTER_DATE = date;
    try {
      r.git('add', '-A');
      r.git('commit', '-qm', msg);
    } finally {
      delete process.env.GIT_COMMITTER_DATE;
    }
  };
  r.put('.work/CD-2/handoff.md', 'status: in-progress\n\n## Next step\n\nmerge #4\n\n## Open questions\n');
  const later = (min) => new Date(Date.now() + min * 60_000).toISOString();
  commitAt(later(1), 'note');
  assert.equal(staleness(), null);
  r.put('a.js', 'x');
  commitAt(later(2), 'code');
  assert.equal(staleness(), 'code commits are newer than the last committed note');
  r.put('.work/CD-2/handoff.md', 'status: done\n');
  assert.equal(staleness(), null);
});

test('a published artifact is recorded and stays unlinked until one note line carries the URL with an issue id', async () => {
  const r = repo({ branch: 'cd-3-x' });
  const URL_A = 'https://claude.ai/artifact/AbC123xyz';
  const out = await hook('post-artifact', { tool_name: 'Artifact', tool_input: { file_path: 'x.html' }, tool_response: `Published ${URL_A} (Version 1)` }, { cwd: r.dir });
  assert.match(out.json.hookSpecificOutput.additionalContext, /moderator linear update <ID> --link/);
  await hook('post-artifact', { tool_name: 'Artifact', tool_input: { action: 'read', url: URL_A }, tool_response: URL_A }, { cwd: r.dir });
  await hook('post-artifact', { tool_name: 'Artifact', tool_input: { url: URL_A, asset: true, file_path: 'a.png' }, tool_response: URL_A }, { cwd: r.dir });
  assert.equal(r.read('.work/CD-3/events.jsonl').trim().split('\n').length, 1, 'reads and asset uploads record nothing');

  process.chdir(r.dir);
  const note = (body) => r.put('.work/CD-3/handoff.md', `status: in-progress\n\n${body}\n<!-- auto:start -->\n${URL_A} CD-9\n<!-- auto:end -->\n`);
  note(`- Drafted on ${URL_A}`);
  assert.deepEqual(unlinkedArtifacts(), [URL_A]);
  note(`- CD-118\n- ${URL_A}`);
  assert.deepEqual(unlinkedArtifacts(), [URL_A]);
  note(`- ${URL_A}Z on CD-118`);
  assert.deepEqual(unlinkedArtifacts(), [URL_A], 'a longer URL does not count for its prefix');
  note(`- Settings canvas ${URL_A}, linked on CD-118`);
  assert.deepEqual(unlinkedArtifacts(), []);
});

test('the issue must be read this session, by the connector whatever its server is called; a unit\'s read does not count', () => {
  const r = repo({ branch: 'cd-1-x' });
  process.chdir(r.dir);
  const gaps = (records) => linearGaps({ transcriptPath: transcript(r.scratch, records) });
  assert.match(gaps([toolUse('Bash', { command: 'ls' })]).join(), /CD-1 was not read/);
  assert.deepEqual(gaps([toolUse('mcp__Linear__get_issue', { id: 'cd-1' })]), []);
  assert.deepEqual(gaps([toolUse('mcp__e2d49494-0a12-4608-8ece-ee7ee88d4832__list_comments', { issueId: 'CD-1' })]), []);
  assert.match(gaps([toolUse('mcp__Linear__get_issue', { id: 'CD-12' })]).join(), /CD-1 was not read/);
  assert.match(gaps([toolUse('mcp__github__issue_read', { issue_number: 'CD-1' })]).join(), /CD-1 was not read/);
  assert.match(gaps([{ isSidechain: true, ...toolUse('mcp__Linear__get_issue', { id: 'CD-1' }) }]).join(), /CD-1 was not read/);
  assert.deepEqual(linearGaps({ transcriptPath: `${r.scratch}/missing.jsonl` }), []);
});
