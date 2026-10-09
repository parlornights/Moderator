// The learnings log (papercuts in moderator.config.json, docs/papercuts.md by default). Append-only until a
// consolidation folds its entries into the rules and marks them.

import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { root } from './git.js';
import { appendEvent, issueId } from './work.js';

/** gate: a check ran that should not have, or did not run; scope: a config rule; protocol: a skill, agent or rule
 *  line; repo: a command or path the repo map lacks; flake: a test that fails without a code cause. */
export const CATEGORIES = ['gate', 'scope', 'protocol', 'repo', 'flake'];
const OPEN = '## Unconsolidated';

const file = () => path.join(root(), config()?.papercuts ?? 'docs/papercuts.md');

function load() {
  const p = file();
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `# Papercuts\n\nOne line per thing that cost time and should not have. Appended by \`moderator papercut\`, folded into the rules by a consolidation, then moved below.\n\n${OPEN}\n\n`);
  }
  return fs.readFileSync(p, 'utf8');
}

/** The open section's bounds in the log: [start of its body, end of its body]. */
function openSection(/** @type {string} */ doc) {
  const start = doc.indexOf(OPEN) + OPEN.length;
  const next = doc.slice(start).search(/\n## /);
  return [start, next >= 0 ? start + next : doc.length];
}

/**
 * @param {string} category
 * @param {string} text
 */
export function add(category, text) {
  if (!CATEGORIES.includes(category)) throw new Error(`category must be one of ${CATEGORIES.join(', ')}`);
  const line = `- ${new Date().toISOString().slice(0, 10)} | ${issueId() || '-'} | ${category} | ${text.replace(/\s+/g, ' ').trim()}`;
  const doc = load();
  const [start, end] = openSection(doc);
  fs.writeFileSync(file(), `${doc.slice(0, start)}${doc.slice(start, end).replace(/\s*$/, '')}\n${line}\n${doc.slice(end)}`);
  appendEvent('papercut', { category, text: text.slice(0, 120) });
  return line;
}

export function unconsolidated() {
  const doc = load();
  const [start, end] = openSection(doc);
  return doc.slice(start, end).split('\n').filter((l) => l.startsWith('- '));
}

/** Move every open entry under "## Consolidated <date>". Returns how many. */
export function mark() {
  const entries = unconsolidated();
  if (!entries.length) return 0;
  const doc = load();
  const [start, end] = openSection(doc);
  fs.writeFileSync(file(), `${doc.slice(0, start)}\n\n## Consolidated ${new Date().toISOString().slice(0, 10)}\n\n${entries.join('\n')}\n${doc.slice(end)}`);
  return entries.length;
}

/** The session-start line that sends the agent to read the whole log; nothing when there is no entry. Read-only. */
export function papercutPointer() {
  const p = file();
  if (!fs.existsSync(p)) return '';
  const count = fs.readFileSync(p, 'utf8').split('\n').filter((l) => /^- \d{4}-\d{2}-\d{2}\b/.test(l)).length;
  if (!count) return '';
  return `Papercuts: read ${path.relative(root(), p)} in full now (${count} entries, consolidated and not). They are the learnings earlier sessions paid for.`;
}
