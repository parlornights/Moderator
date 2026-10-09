// The protocol's skills and agents, shipped in this package's claude/ and copied into a repo's .claude/: cloud
// sessions load a repo's own .claude/skills and .claude/agents, and no plugin reaches them without an organization's
// managed settings. `check` finds a copy that drifted from the pinned version, so CI can fail on it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { root } from './git.js';

const SOURCE = fileURLToPath(new URL('../claude/', import.meta.url));

/** Every shipped file, relative to claude/ (skills/<name>/SKILL.md, agents/<name>.md), sorted. */
export function shipped() {
  return fs.readdirSync(SOURCE, { recursive: true, encoding: 'utf8' }).filter((f) => fs.statSync(path.join(SOURCE, f)).isFile()).sort();
}

/** Copy every shipped file into the repo's .claude/. Returns the files written. */
export function sync() {
  return shipped().map((f) => {
    const to = path.join(root(), '.claude', f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(SOURCE, f), to);
    return path.join('.claude', f);
  });
}

/** The repo's copies that are missing or differ from the shipped ones: [{ file, why }]. */
export function check() {
  const drift = [];
  for (const f of shipped()) {
    const to = path.join(root(), '.claude', f);
    const rel = path.join('.claude', f);
    if (!fs.existsSync(to)) drift.push({ file: rel, why: 'missing' });
    else if (!fs.readFileSync(to).equals(fs.readFileSync(path.join(SOURCE, f)))) drift.push({ file: rel, why: 'differs from the pinned version' });
  }
  return drift;
}
