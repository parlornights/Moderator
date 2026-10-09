import * as audit from './audit';
import type { Env } from './env';
import { CONTEXT, type Check, type GitHub } from './github';
import { diffHash, existingTestHunks, hunkHash, type Hunk } from './hunks';
import type { Answers, Ask, Question } from './jev';
import type { Linear, Ticket } from './linear';

/** A hunk is flagged when Jev's probability that the ticket sanctions it falls below this. */
export const SANCTIONED = 0.5;
/** Hunks go to Jev in requests of at most this many hunks and characters; every hunk is judged. */
const BATCH_HUNKS = 20;
const BATCH_CHARS = 40_000;

export interface Finding extends Hunk {
  p: number | null;
  reason: string;
}

export interface PullRequestEvent {
  action?: string;
  changes?: { base?: unknown };
  installation: { id: number };
  repository: { name: string; full_name: string; owner: { login: string } };
  pull_request: {
    number: number;
    title: string;
    head: { sha: string };
    base: { sha: string; ref: string };
    user: { login: string };
    created_at: string;
    changed_files: number;
  };
}

/** Two of each, so the samples do not lean either way. */
const SAMPLES = [
  {
    ticket: 'Names may be 32 characters (was 24). Done when 32 is accepted and 33 refused.',
    hunk: "-  expect(valid('x'.repeat(25))).toBe(false);\n+  expect(valid('x'.repeat(33))).toBe(false);",
    sanctioned: true,
  },
  { ticket: 'Players can rename a saved game.', hunk: '-  expect(total).toBe(120);\n+  expect(total).toBeGreaterThan(0);', sanctioned: false },
  {
    ticket: 'Players can rename a saved game.',
    hunk: "-  const game = makeGame();\n+  const game = makeGame({ name: 'Old' });\n+  rename(game, 'New');\n+  expect(game.name).toBe('New');",
    sanctioned: true,
  },
  { ticket: 'Players can rename a saved game.', hunk: "-  it('rejects an expired token', async () => {\n+  it.skip('rejects an expired token', async () => {", sanctioned: false },
];

/** The issue the PR title starts with, as in `CD-269: ...`. */
export const issueIdIn = (title: string) => title.match(/^\s*([A-Z][A-Z0-9]+-\d+):/)?.[1] ?? null;

const question = (n: number, h: Hunk): Question => ({
  type: 'noul',
  instructions: `Does the ticket sanction hunks[${n}], a change to the existing test file ${h.file}? samples holds two sanctioned and two unsanctioned examples.`,
  criteria: {
    true: 'Sanctioned: the change keeps the test as strong as before, or makes the change the ticket asks for',
    false: 'Not sanctioned: the change weakens, removes, skips or bends the test in a way the ticket does not ask for',
  },
});

/** Splits hunks into Jev requests by count and size; a hunk larger than the limit goes alone. */
function batches(hunks: Hunk[]): Hunk[][] {
  const out: Hunk[][] = [];
  let size = 0;
  for (const h of hunks) {
    const last = out.at(-1);
    if (!last || last.length >= BATCH_HUNKS || size + h.patch!.length > BATCH_CHARS) {
      out.push([h]);
      size = h.patch!.length;
    } else {
      last.push(h);
      size += h.patch!.length;
    }
  }
  return out;
}

/**
 * Judges every hunk that changes an existing test against the PR's ticket. Null: Jev did not answer, so the caller
 * flags everything. A file GitHub shows no diff for is flagged: Jev cannot judge what it cannot read.
 */
export async function judge(ask: Ask, ticket: Ticket | null, hunks: Hunk[]): Promise<Finding[] | null> {
  const p = new Map<Hunk, number>();
  const answered = await Promise.all(
    batches(hunks.filter((h) => h.patch !== null)).map(async (batch) => {
      const state = { ticket: ticket ?? '(no ticket text written before this work began)', hunks: batch.map((h) => ({ file: h.file, status: h.status, patch: h.patch })), samples: SAMPLES };
      const answers: Answers | null = await ask(state, Object.fromEntries(batch.map((h, n) => [`h${n + 1}`, question(n, h)])));
      batch.forEach((h, n) => answers && p.set(h, Math.round((answers[`h${n + 1}`]?.noul ?? 0) * 100) / 100));
      return answers !== null;
    }),
  );
  if (answered.includes(false)) return null;
  return hunks.flatMap((h): Finding[] => {
    if (h.patch === null) return [{ ...h, p: null, reason: 'GitHub shows no diff for this file (binary or too large), so Jev could not read it' }];
    const ph = p.get(h)!;
    return ph < SANCTIONED ? [{ ...h, p: ph, reason: 'Jev does not read this change as sanctioned by the ticket' }] : [];
  });
}

export interface IntegrityDeps {
  github: GitHub;
  linear: Linear;
  jev: Ask;
}

const approveUrl = (env: Env, k: Key) => `${env.PUBLIC_URL}/approve/${k.repo}/${k.pr}/${k.sha}`;

export interface Key {
  repo: string;
  pr: number;
  sha: string;
}

/**
 * One fingerprint per test file: the hashes of all its changed hunks. A file whose changes are exactly those the owner
 * approved has the same fingerprint on a later commit; any change to it gives another.
 */
async function fileHashes(hunks: Hunk[]): Promise<Map<string, string>> {
  const byFile = new Map<string, string[]>();
  for (const h of hunks) byFile.set(h.file, [...(byFile.get(h.file) ?? []), await hunkHash(h)]);
  const out = new Map<string, string>();
  for (const [file, hashes] of byFile) out.set(file, await hunkHash({ file, status: 'file', patch: hashes.sort().join('\n') }));
  return out;
}

const keyOf = (e: PullRequestEvent): Key => ({ repo: e.repository.full_name, pr: e.pull_request.number, sha: e.pull_request.head.sha });
const decided = (row: IntegrityRow | null) => row?.state === 'approved' || row?.state === 'rejected';

/**
 * When the PR's work began: the earliest of GitHub's own PR creation time and every commit date. Commit dates are set
 * by whoever commits; backdating one only makes this earlier, which counts less ticket text.
 */
export function workStart(e: PullRequestEvent, commitDates: string[]): Date {
  return new Date(Math.min(Date.parse(e.pull_request.created_at), ...commitDates.map(Date.parse).filter((d) => !Number.isNaN(d))));
}

interface Run {
  state: 'pending' | 'success' | 'failure';
  result: string;
  findings: Finding[];
  issue: string | null;
}

/**
 * Records a run for this PR, base and commit. A decision the owner already made stays, unless the PR's base branch
 * changed, which makes it a different diff. False when the row was left as it was.
 */
async function save(env: Env, e: PullRequestEvent, run: Run): Promise<boolean> {
  const k = keyOf(e);
  const { meta } = await env.DB.prepare(
    `INSERT INTO integrity (repo, pr, sha, base_ref, installation_id, title, issue, state, result, findings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo, pr, sha) DO UPDATE SET base_ref = excluded.base_ref, installation_id = excluded.installation_id, title = excluded.title, issue = excluded.issue,
       state = excluded.state, result = excluded.result, findings = excluded.findings, created_at = excluded.created_at, decided_by = NULL, decided_at = NULL, reason = NULL
     WHERE integrity.state NOT IN ('approved', 'rejected') OR integrity.base_ref != excluded.base_ref`,
  )
    .bind(k.repo, k.pr, k.sha, e.pull_request.base.ref, e.installation.id, e.pull_request.title, run.issue, run.state, run.result, JSON.stringify(run.findings), new Date().toISOString())
    .run();
  return meta.changes > 0;
}

function summary(findings: Finding[]) {
  return findings.map((f) => `- \`${f.file}\`${f.p === null ? '' : ` (sanctioned p=${f.p})`}: ${f.reason}`).join('\n');
}

/** The check run a row stands for. Every run posts from the row as it is after saving, so the last post matches the row. */
function checkFor(env: Env, row: IntegrityRow): Check {
  const detailsUrl = approveUrl(env, row);
  const findings = JSON.parse(row.findings) as Finding[];
  switch (row.state) {
    case 'approved':
      return { conclusion: 'success', title: `Approved by ${row.decided_by}`, summary: row.reason ?? `Approved for ${row.sha}.`, detailsUrl };
    case 'rejected':
      return { conclusion: 'failure', title: `Rejected by the owner${row.reason ? `: ${row.reason}` : ''}`, summary: row.reason ?? 'Rejected without a reason.', detailsUrl };
    case 'success':
      return { conclusion: 'success', title: row.result, summary: row.result, detailsUrl };
    case 'failure':
      return { conclusion: 'action_required', title: row.result, summary: summary(findings) || row.result, detailsUrl };
    default:
      return { title: row.result, summary: row.result, detailsUrl };
  }
}

async function publish(env: Env, gh: GitHub, e: PullRequestEvent, run: Run): Promise<void> {
  const k = keyOf(e);
  const [owner, repo] = [e.repository.owner.login, e.repository.name];
  const changed = await save(env, e, run);
  const row = await getRow(env.DB, k);
  if (row) await gh.setCheck(e.installation.id, owner, repo, k.sha, checkFor(env, row));
  if (!changed || run.state === 'pending') return;
  await audit.record(env.DB, { action: `github/${CONTEXT}`, input: { ...k, base: e.pull_request.base.ref, issue: run.issue }, jev: run.findings, outcome: run.state, response: { result: run.result } });
  if (run.state === 'failure')
    await commentSafely(gh, e.installation.id, owner, repo, k.pr, `@${e.pull_request.user.login} **test-integrity** on ${short(k.sha)}: ${run.result}.\n\n${summary(run.findings)}\n\nApprove or reject: ${approveUrl(env, k)}`);
}

/** Runs the check for one PR head and posts the `test-integrity` check run. */
export async function check(env: Env, deps: IntegrityDeps, e: PullRequestEvent): Promise<void> {
  const k = keyOf(e);
  const [owner, repo] = [e.repository.owner.login, e.repository.name];
  const prior = await getRow(env.DB, k);
  if (decided(prior) && prior!.base_ref === e.pull_request.base.ref) {
    await deps.github.setCheck(e.installation.id, owner, repo, k.sha, checkFor(env, prior!));
    return;
  }
  const issue = issueIdIn(e.pull_request.title);
  // Recorded first, so a run that never finishes still leaves something the owner can decide.
  await publish(env, deps.github, e, { state: 'pending', result: 'Checking test changes', findings: [{ file: '(check)', status: 'pending', patch: null, p: null, reason: 'The check started but has not finished; decide from the PR diff' }], issue });

  const { files, commitDates } = await deps.github.compare(e.installation.id, owner, repo, e.pull_request.base.sha, k.sha);
  const fingerprint = await diffHash(files);
  await env.DB.prepare('UPDATE integrity SET diff_hash = ? WHERE repo = ? AND pr = ? AND sha = ?').bind(fingerprint, k.repo, k.pr, k.sha).run();
  if (await carryApproval(env, deps.github, e, fingerprint)) return;
  const all = existingTestHunks(files);
  // A file whose changes the owner approved on an earlier commit of this PR and base, unchanged since (owner, Q48 A).
  const byFile = await fileHashes(all.filter((h) => h.patch !== null));
  await env.DB.prepare('UPDATE integrity SET test_files = ? WHERE repo = ? AND pr = ? AND sha = ?').bind(JSON.stringify(Object.fromEntries(byFile)), k.repo, k.pr, k.sha).run();
  const approvedFiles = new Map(
    (await env.DB.prepare('SELECT hash, sha, decided_by FROM approved_files WHERE repo = ? AND pr = ? AND base_ref = ?').bind(k.repo, k.pr, e.pull_request.base.ref).all<{ hash: string; sha: string; decided_by: string }>()).results.map((r) => [r.hash, r]),
  );
  const carried = all.filter((h) => h.patch !== null && approvedFiles.has(byFile.get(h.file)!));
  const hunks = all.filter((h) => !carried.includes(h));
  const sticky = new Set(
    (await env.DB.prepare('SELECT hash FROM flags WHERE repo = ? AND pr = ?').bind(k.repo, k.pr).all<{ hash: string }>()).results.map((r) => r.hash),
  );
  const hashes = new Map(await Promise.all(hunks.map(async (h) => [h, await hunkHash(h)] as const)));
  const again = hunks.filter((h) => h.patch !== null && sticky.has(hashes.get(h)!));
  const fresh = hunks.filter((h) => !again.includes(h));
  const ticket = issue && fresh.length ? await deps.linear.ticketBefore(issue, workStart(e, commitDates)) : null;
  const judged = fresh.length ? await judge(deps.jev, ticket, fresh) : [];
  const findings: Finding[] = [
    ...again.map((h): Finding => ({ ...h, p: null, reason: 'Flagged on an earlier commit of this PR and unchanged since' })),
    ...(judged ?? fresh.map((h): Finding => ({ ...h, p: null, reason: 'Jev did not answer' }))),
  ];
  if (files.length < e.pull_request.changed_files)
    findings.push({ file: '(whole PR)', status: 'unlisted', patch: null, p: null, reason: `GitHub listed ${files.length} of the PR's ${e.pull_request.changed_files} files, so the rest were not checked` });

  for (const f of findings) if (f.patch !== null) await env.DB.prepare('INSERT OR IGNORE INTO flags (repo, pr, hash) VALUES (?, ?, ?)').bind(k.repo, k.pr, await hunkHash(f)).run();
  const carriedFiles = [...new Set(carried.map((h) => h.file))];
  const carriedText = `${carried.length} approved earlier by ${[...new Set(carriedFiles.map((f) => approvedFiles.get(byFile.get(f)!)!.decided_by))].join(', ')} and unchanged since (${carriedFiles.join(', ')})`;
  const approvedNote = carried.length ? `; ${carriedText}` : '';
  const result = findings.length
    ? judged === null && fresh.length
      ? "Jev did not answer: the owner's decision is needed"
      : `${findings.length} test change(s) need the owner's decision${approvedNote}`
    : hunks.length
      ? `${hunks.length} test change(s), all sanctioned${approvedNote}`
      : carried.length
        ? `No new test change: ${carriedText}`
        : 'No existing test changed';
  await publish(env, deps.github, e, { state: findings.length ? 'failure' : 'success', result, findings, issue });
}

/**
 * A push that only brings the base branch into the PR leaves the PR's own diff as it was; an approval of that same diff
 * on this PR and base carries over (owner, Q34 A). Any change to the PR's own diff needs a new decision.
 */
async function carryApproval(env: Env, gh: GitHub, e: PullRequestEvent, fingerprint: string): Promise<boolean> {
  const k = keyOf(e);
  const earlier = await env.DB.prepare(
    "SELECT sha, decided_by FROM integrity WHERE repo = ? AND pr = ? AND base_ref = ? AND diff_hash = ? AND state = 'approved' AND sha != ? ORDER BY decided_at DESC LIMIT 1",
  )
    .bind(k.repo, k.pr, e.pull_request.base.ref, fingerprint, k.sha)
    .first<{ sha: string; decided_by: string }>();
  if (!earlier) return false;
  const { meta } = await env.DB.prepare(
    "UPDATE integrity SET state = 'approved', decided_by = ?, decided_at = ?, reason = ?, result = ?, findings = '[]' WHERE repo = ? AND pr = ? AND sha = ? AND state NOT IN ('approved', 'rejected')",
  )
    .bind(earlier.decided_by, new Date().toISOString(), `Carried from ${short(earlier.sha)}: the PR's own diff is unchanged`, 'Approval carried over', k.repo, k.pr, k.sha)
    .run();
  const row = await getRow(env.DB, k);
  if (row) await gh.setCheck(e.installation.id, e.repository.owner.login, e.repository.name, k.sha, checkFor(env, row));
  if (meta.changes > 0) await audit.record(env.DB, { action: `carry/${CONTEXT}`, input: { ...k, from: earlier.sha }, outcome: 'approved', response: { by: earlier.decided_by } });
  return true;
}

/** A run that threw still leaves a red check and a row, so the PR does not wait forever and the owner can decide. */
export async function errored(env: Env, gh: GitHub, e: PullRequestEvent, err: unknown): Promise<void> {
  const reason = `The check errored: ${err instanceof Error ? err.message : String(err)}`;
  await publish(env, gh, e, { state: 'failure', result: "The check errored: the owner's decision is needed", findings: [{ file: '(check)', status: 'error', patch: null, p: null, reason }], issue: issueIdIn(e.pull_request.title) });
}

const short = (sha: string) => sha.slice(0, 7);

/** The check and the record are what count; a comment that fails is logged, not retried. */
async function commentSafely(gh: GitHub, installationId: number, owner: string, repo: string, pr: number, body: string) {
  try {
    await gh.comment(installationId, owner, repo, pr, body);
  } catch (e) {
    console.error('test-integrity comment failed', `${owner}/${repo}#${pr}`, e);
  }
}

export interface IntegrityRow extends Key {
  base_ref: string;
  installation_id: number;
  title: string;
  issue: string | null;
  state: string;
  result: string;
  findings: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  diff_hash: string | null;
  test_files: string | null;
}

export const getRow = (db: D1Database, k: Key) => db.prepare('SELECT * FROM integrity WHERE repo = ? AND pr = ? AND sha = ?').bind(k.repo, k.pr, k.sha).first<IntegrityRow>();

/**
 * The owner's decision on one commit. Approve: the status turns green for that commit only. Reject: it stays red, and
 * the App comments on the PR with the reason so the agent working on it sees it.
 */
export async function decide(env: Env, gh: GitHub, row: IntegrityRow, d: { by: string; approve: boolean; reason?: string }): Promise<void> {
  const decision: IntegrityRow = { ...row, state: d.approve ? 'approved' : 'rejected', decided_by: d.by, decided_at: new Date().toISOString(), reason: d.reason?.trim() || null };
  const [owner, repo] = row.repo.split('/');
  // The check first: if GitHub refuses it, nothing is recorded and the page still offers the decision.
  await gh.setCheck(row.installation_id, owner, repo, row.sha, checkFor(env, decision));
  const { meta } = await env.DB.prepare("UPDATE integrity SET state = ?, decided_by = ?, decided_at = ?, reason = ? WHERE repo = ? AND pr = ? AND sha = ? AND state NOT IN ('approved', 'rejected')")
    .bind(decision.state, decision.decided_by, decision.decided_at, decision.reason, row.repo, row.pr, row.sha)
    .run();
  if (d.approve && meta.changes > 0) {
    // Each approved test file, by the exact changes it carries at this commit, so a later commit that leaves it as it
    // is keeps the approval (owner, Q48 A).
    const files = new Set((JSON.parse(row.findings) as Finding[]).filter((f) => f.patch !== null).map((f) => f.file));
    const hashes = JSON.parse(row.test_files ?? '{}') as Record<string, string>;
    for (const [file, hash] of Object.entries(hashes).filter(([f]) => files.has(f)))
      await env.DB.prepare('INSERT OR IGNORE INTO approved_files (repo, pr, base_ref, hash, file, sha, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(row.repo, row.pr, row.base_ref, hash, file, row.sha, d.by).run();
  }
  if (!d.approve) {
    const body = [`The owner **rejected** the test changes in ${short(row.sha)}.`, decision.reason ? `\n> ${decision.reason.replace(/\n/g, '\n> ')}` : '', '\nRevert or rework them, then push; the new commit is checked again.'].join('\n');
    await commentSafely(gh, row.installation_id, owner, repo, row.pr, body);
  }
  await audit.record(env.DB, { action: `${d.approve ? 'approve' : 'reject'}/${CONTEXT}`, input: { repo: row.repo, pr: row.pr, sha: row.sha, reason: decision.reason }, outcome: decision.state, response: { by: d.by } });
}
