// The protocol's skills and agents reach a repo as files in its .claude/, and a copy that drifts is caught.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { cli, repo } from './helpers.js';

test('sync writes every skill and agent; check passes on a fresh copy and fails on an edit or a missing file', async () => {
  const r = repo();
  const missing = await cli(['sync', '--check'], { cwd: r.dir });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /\.claude\/agents\/unit\.md: missing/);
  const wrote = await cli(['sync'], { cwd: r.dir });
  for (const f of ['skills/delegate/SKILL.md', 'skills/handoff/SKILL.md', 'skills/unit-protocol/SKILL.md', 'skills/papercut/SKILL.md', 'agents/unit.md', 'agents/unit-deep.md', 'agents/reviewer.md', 'agents/Explore.md']) {
    assert.match(wrote.stdout, new RegExp(`wrote \\.claude/${f.replace('.', '\\.')}`), f);
  }
  assert.equal((await cli(['sync', '--check'], { cwd: r.dir })).status, 0);
  r.put('.claude/agents/unit.md', `${r.read('.claude/agents/unit.md')}\nYou may push to main.\n`);
  const edited = await cli(['sync', '--check'], { cwd: r.dir });
  assert.equal(edited.status, 1);
  assert.match(edited.stdout, /\.claude\/agents\/unit\.md: differs from the pinned version/);
});

test('the shipped protocol names no project: no CrookedDuke paths, commands or issue ids', () => {
  const dir = new URL('../claude/', import.meta.url);
  for (const f of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((x) => x.endsWith('.md'))) {
    const text = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(text, /harness\/|pnpm (gate|risk|pick|papercut|handoff)|\bCD-\d+|@wg\/|Mergify|ARCHITECTURE/, f);
  }
});
