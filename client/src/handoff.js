// The onboarding note at .work/<issue>/handoff.md. The agent owns the sections above the auto block; this file owns
// the auto block: git state, the last gate, the last 25 turns.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { branch, git, root } from './git.js';
import { toolUses, turns } from './transcript.js';
import { issueId, issuePattern, readEvents, readJson, workDir } from './work.js';

const AUTO_START = '<!-- auto:start -->';
const AUTO_END = '<!-- auto:end -->';

export function handoffPath() {
  return path.join(workDir(), 'handoff.md');
}

/** @param {string | null} issue */
export function skeleton(issue) {
  return [
    `# Handoff: ${issue || '(no issue)'}`,
    '',
    'status: in-progress',
    '',
    '## Goal',
    '',
    '(one paragraph: what done looks like)',
    '',
    '## Criteria',
    '',
    '- [ ] ',
    '',
    '## Decisions',
    '',
    '(what was decided and why, one line each)',
    '',
    '## In flight',
    '',
    '(what is half done right now)',
    '',
    '## Next step',
    '',
    '(the single next action a fresh session should take)',
    '',
    '## Known failures',
    '',
    '(flaky tests, blocked items)',
    '',
    '## Open questions',
    '',
    '(none)',
    '',
    AUTO_START,
    AUTO_END,
    '',
  ].join('\n');
}

/** @param {{ transcriptPath?: string, source?: string }} [opts] */
export function autoSection({ transcriptPath, source } = {}) {
  const out = [];
  out.push(`updated: ${new Date().toISOString()} (${source || 'auto'})`);
  out.push(`branch: ${branch()}  head: ${git(['rev-parse', '--short', 'HEAD']) || '?'}`);
  const st = (git(['status', '--short']) || '').split('\n').filter(Boolean);
  out.push(`uncommitted: ${st.length ? st.slice(0, 15).join(', ') + (st.length > 15 ? ` +${st.length - 15}` : '') : 'none'}`);
  const log = (git(['log', '--oneline', '-8']) || '').split('\n').filter(Boolean);
  if (log.length) {
    out.push('recent commits:');
    log.forEach((l) => out.push(`  ${l}`));
  }
  const gate = readJson(path.join(workDir(), 'gate.json'));
  if (gate) out.push(`last gate: ${gate.ok ? 'GREEN' : 'FAIL'} ${gate.treeHash} at ${gate.at}`);
  const recent = transcriptPath ? turns(transcriptPath) : [];
  if (recent.length) {
    out.push('');
    out.push(`recent turns (last ${recent.length}, newest last):`);
    for (const t of recent) out.push(`  ${t.role}: ${t.text.replace(/\n/g, '\n     ')}`);
  }
  return out.join('\n');
}

/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Refresh the auto block, creating the skeleton when there is no note yet. Returns the path.
 * @param {{ transcriptPath?: string, source?: string }} [opts]
 */
export function writeHandoff(opts = {}) {
  const p = handoffPath();
  let text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : skeleton(issueId());
  if (!text.includes(AUTO_START)) text += `\n${AUTO_START}\n${AUTO_END}\n`;
  const auto = `${AUTO_START}\n${autoSection(opts)}\n${AUTO_END}`;
  text = text.replace(new RegExp(`${esc(AUTO_START)}[\\s\\S]*?${esc(AUTO_END)}`), () => auto);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

/** The note as the agent wrote it: everything above the auto block; empty when there is no note. */
function agentPart() {
  try {
    return fs.readFileSync(handoffPath(), 'utf8').split(AUTO_START)[0];
  } catch {
    return '';
  }
}

/**
 * One `## <heading>` section of the note, without its heading; empty when absent.
 * @param {string} heading
 */
export function section(heading) {
  const m = agentPart().match(new RegExp(`^## ${esc(heading)}[ \\t]*\\n([\\s\\S]*?)(?=\\n## |(?![\\s\\S]))`, 'm'));
  return (m?.[1] ?? '').trim();
}

/** The note's status says the session handed over: its successor carries the work on. */
export function handedOver() {
  return /^status:.*\bhanded over\b/im.test(agentPart());
}

/** Why the note is stale, or null. Commits only: an uncommitted edit does not count until it is committed. */
export function staleness() {
  const p = handoffPath();
  if (!fs.existsSync(p)) return 'there is no handoff note yet';
  if (/^status:\s*done/m.test(agentPart())) return null;
  if (!section('Next step').replace(/\([^)]*\)/g, '').trim()) return '"Next step" is empty';
  const lastCode = Number(git(['log', '-1', '--format=%ct', '--', '.', ':(exclude).work']) || 0);
  const lastNote = Number(git(['log', '-1', '--format=%ct', '--', path.relative(root(), p)]) || 0);
  if (lastCode > lastNote) return 'code commits are newer than the last committed note';
  return null;
}

/**
 * Artifacts this task published (the `artifact` events) that the note does not tie to an issue: no line above the
 * auto block carries the URL together with an issue id.
 */
export function unlinkedArtifacts() {
  const urls = [...new Set(readEvents('artifact').map((e) => e.url).filter(Boolean))];
  const issue = issuePattern();
  if (!urls.length || !issue) return [];
  const lines = agentPart().split('\n');
  return urls.filter((url) => {
    const at = new RegExp(`${esc(url)}(?![\\w-])`);
    return !lines.some((l) => at.test(l) && issue.test(l.replace(at, ' ')));
  });
}

/**
 * Where this session left Linear out: the task's issue was never read this session. Reads stay on the Linear
 * connector, so its get_issue or list_comments call naming the issue is the evidence (a connector's tool names carry
 * its server's id, which need not say Linear).
 * @param {{ transcriptPath?: string }} [opts]
 */
export function linearGaps({ transcriptPath } = {}) {
  const issue = issueId();
  if (!issue || !transcriptPath) return [];
  const calls = toolUses(transcriptPath);
  if (!calls) return [];
  const names = new RegExp(`\\b${issue}\\b`, 'i');
  const read = calls.some((c) => /(?:^|__)(?:get_issue|list_comments)$/.test(c.name) && names.test(JSON.stringify(c.input)));
  return read ? [] : [`${issue} was not read on Linear this session: get_issue and list_comments are the task's context (the owner's words, the design, the decisions so far)`];
}

/** Hash of the note above its auto block: what the agent wrote, not what the hooks refresh. */
export function noteHash() {
  return crypto.createHash('sha1').update(agentPart().trim()).digest('hex').slice(0, 12);
}

/**
 * The context passed the handoff share this session (a `context-high` event) and the note has not changed since:
 * the next session would start from a stale note. A reason, or null.
 * @param {{ sessionId?: string }} [opts]
 */
export function contextHandoffDue({ sessionId } = {}) {
  if (!sessionId) return null;
  const last = readEvents('context-high').filter((e) => e.session === sessionId).at(-1);
  if (!last || noteHash() !== last.note) return null;
  const share = Math.round((last.tokens / (config()?.context.window ?? 1_000_000)) * 100);
  return `the context passed ${share}% of the window and the handoff note has not changed since: write it for the next session (status, Next step, decisions with reasons, open questions, PRs and units in flight), commit, push, tell the owner a new session should take over, and stop`;
}
