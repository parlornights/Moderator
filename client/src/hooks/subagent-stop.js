// SubagentStop (matcher: unit|unit-deep). A unit may stop only with:
//   - a BLOCKED line, or a NEEDS DECISION line Jev reads as one whole question with options and a recommendation;
//   - or a valid HANDBACK block, a gate GREEN for the tree as it is now, and, when acceptance criteria are written
//     down, no criterion Jev reads as missing from the diff.
// Otherwise it is blocked with the failure as its next prompt. After MAX_BLOCKS it is let through as blocked, so a
// unit never loops forever. Jev not answering never blocks: its check is skipped.

import fs from 'node:fs';
import path from 'node:path';

import { jev } from '../api.js';
import { requireConfig } from '../config.js';
import { git } from '../git.js';
import { checkHandback, parseHandback, SHAPE } from '../handback.js';
import { formatGate, runGate } from '../gate.js';
import { add as addPapercut } from '../papercut.js';
import { diffSummary } from '../risk.js';
import { waitsFile } from '../units.js';
import { appendEvent, readJson, workDir, writeJson } from '../work.js';

import { block } from './io.js';

const MAX_BLOCKS = 3;

/**
 * The acceptance criteria: .work/<issue>/criteria.md (one per line), else the Criteria checkboxes of handoff.md.
 * @param {string} dir
 */
function readCriteria(dir) {
  const clean = (/** @type {string} */ l) => l.replace(/^\s*(-|\d+\.|\[.\]|- \[.\])\s*/, '').trim();
  try {
    return fs.readFileSync(path.join(dir, 'criteria.md'), 'utf8').split('\n').map(clean).filter(Boolean);
  } catch {
    /* fall through */
  }
  try {
    const t = fs.readFileSync(path.join(dir, 'handoff.md'), 'utf8');
    const sec = (t.match(/## Criteria\s*\n([\s\S]*?)\n## /) || [])[1] || '';
    return sec.split('\n').filter((l) => /^\s*- \[/.test(l)).map(clean).filter(Boolean);
  } catch {
    return [];
  }
}

/** The diff since the merge base plus working-tree edits, without .work/ and lockfiles; capped for Jev. */
function diffText() {
  const mb = git(['merge-base', requireConfig().base, 'HEAD']);
  const skip = [':(exclude).work', ':(exclude)pnpm-lock.yaml', ':(exclude)package-lock.json', ':(exclude)yarn.lock'];
  const diff = [mb ? git(['diff', mb, 'HEAD', '--', '.', ...skip]) : null, git(['diff', 'HEAD', '--', '.', ...skip])].filter(Boolean).join('\n');
  return diff.slice(0, 24_000);
}

/** @param {any} input */
export default async function subagentStop(input) {
  if (input.last_assistant_message === undefined) return; // malformed hook input: fail open, never trap a unit
  const dir = workDir();
  const id = input.agent_id || 'unit';
  const countsPath = path.join(dir, 'stop-blocks.json');
  const counts = readJson(countsPath, {});
  const blocks = counts[id] || 0;

  /**
   * @param {string} kind
   * @param {Record<string, unknown>} [data]
   */
  const finish = (kind, data = {}) => {
    const runningPath = path.join(dir, 'running.json');
    const running = readJson(runningPath);
    if (running) {
      delete running[id];
      writeJson(runningPath, running);
    }
    delete counts[id];
    writeJson(countsPath, counts);
    fs.rmSync(waitsFile(id), { force: true });
    appendEvent(`unit:${kind}`, { id: id.slice(0, 8), ...data });
  };
  /** @param {string} reason */
  const refuse = (reason) => {
    counts[id] = blocks + 1;
    writeJson(countsPath, counts);
    appendEvent('unit:blocked', { id: id.slice(0, 8), n: blocks + 1, why: reason.split('\n')[0].slice(0, 120) });
    return block(`${reason}\n\n(block ${blocks + 1} of ${MAX_BLOCKS}; after ${MAX_BLOCKS} you are let through with status "blocked")`);
  };

  const last = String(input.last_assistant_message);
  const parsed = parseHandback(last);

  if (parsed.kind === 'blocked') return finish('escalate-blocked', { text: String(parsed.text).slice(0, 160) });
  if (parsed.kind === 'decision') {
    const judged = blocks < MAX_BLOCKS ? await jev('needs-decision', { escalation: String(parsed.text).slice(0, 4000) }) : null;
    if (judged && !judged.pass) return refuse(`Your NEEDS DECISION line does not ask one whole question with options and a recommendation (Jev). Shape:\n${SHAPE.decision}`);
    return finish('escalate-decision', { text: String(parsed.text).slice(0, 160) });
  }

  if (blocks >= MAX_BLOCKS) return finish('forced', { reason: 'max blocks reached' });
  if (!parsed.ok) return refuse(`Your last message is not a hand-back. ${parsed.errors.join('; ')}. End with the HANDBACK block:\n${SHAPE.done}\nor one escalation line:\n${SHAPE.blocked}\n${SHAPE.decision}`);

  const done = parsed.handback?.status === 'done';
  if (done) {
    const gate = runGate({ ifChanged: true });
    if (!gate.ok) return refuse(`Gate is not green for the current tree. Fix these, run \`moderator gate\` until GREEN, then hand back again.\n\n${formatGate(gate)}`);
  }
  const res = checkHandback(last);
  if (!res.ok) return refuse(`Hand-back rejected: ${res.errors.join('; ')}.`);

  // Jev's verdict per acceptance criterion, read from the diff itself, never from the unit's narration.
  const criteria = readCriteria(dir);
  if (done && criteria.length) {
    const v = await jev('verdict', { criteria: criteria.slice(0, 30), diff: diffText(), summary: diffSummary() });
    if (v) {
      appendEvent('jev:verdict', { results: v.results?.map((/** @type {{ p: number }} */ x) => x.p) });
      if (v.block?.length) {
        return refuse(
          `Jev reads the diff as not satisfying these criteria (probability it does):\n${v.block.map((/** @type {{ p: number, criterion: string }} */ x) => `  ${x.p}  ${x.criterion}`).join('\n')}\nEither implement and test them, or explain in "notes" why the criterion does not apply, then hand back again.`,
        );
      }
    }
  }

  // Learnings the unit reported go straight into the papercut log ("category: text", protocol by default).
  for (const pc of res.handback?.papercuts ?? []) {
    const m = String(pc).match(/^(gate|scope|protocol|repo|flake):\s*(.+)$/i);
    try {
      addPapercut(m ? m[1].toLowerCase() : 'protocol', m ? m[2] : String(pc));
    } catch {
      /* the log is best effort */
    }
  }
  finish('handback', { status: res.handback?.status, pr: res.handback?.pr ?? null, warnings: res.warnings });
}
