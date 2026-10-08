import * as audit from './audit';
import type { Env } from './env';
import { CONTEXT, type GitHub, type Status } from './github';
import { existingTestHunks, type Hunk } from './hunks';
import type { Answers, Ask, Question } from './jev';
import type { Issue, Linear } from './linear';

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
  installation: { id: number };
  repository: { name: string; full_name: string; owner: { login: string } };
  pull_request: { number: number; title: string; head: { sha: string }; user: { login: string } };
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

export const issueIdIn = (title: string) => title.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0] ?? null;

const question = (n: number, h: Hunk): Question => ({
  type: 'noul',
  instructions: `Does the ticket sanction hunks[${n}], a change to an existing test, fixture or snapshot in ${h.file}? samples holds two sanctioned and two unsanctioned examples.`,
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
export async function judge(ask: Ask, ticket: Issue | null, hunks: Hunk[]): Promise<Finding[] | null> {
  const p = new Map<Hunk, number>();
  for (const batch of batches(hunks.filter((h) => h.patch !== null))) {
    const state = { ticket: ticket ?? '(the PR names no ticket)', hunks: batch.map((h) => ({ file: h.file, status: h.status, patch: h.patch })), samples: SAMPLES };
    const answers: Answers | null = await ask(state, Object.fromEntries(batch.map((h, n) => [`h${n + 1}`, question(n, h)])));
    if (!answers) return null;
    batch.forEach((h, n) => p.set(h, Math.round((answers[`h${n + 1}`]?.noul ?? 0) * 100) / 100));
  }
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

const approveUrl = (env: Env, repo: string, sha: string) => `${env.PUBLIC_URL}/approve/${repo}/${sha}`;

/** Runs the check for one PR head and posts the `test-integrity` status. */
export async function check(env: Env, deps: IntegrityDeps, e: PullRequestEvent): Promise<void> {
  const { installation, repository, pull_request: pr } = e;
  const [owner, repo, sha] = [repository.owner.login, repository.name, pr.head.sha];
  const targetUrl = approveUrl(env, repository.full_name, sha);

  const prior = await getRow(env.DB, repository.full_name, sha);
  if (prior?.state === 'approved' || prior?.state === 'rejected') {
    await deps.github.setStatus(installation.id, owner, repo, sha, decisionStatus(env, prior));
    return;
  }

  const hunks = existingTestHunks(await deps.github.pullFiles(installation.id, owner, repo, pr.number));
  const issue = issueIdIn(pr.title);
  const findings = hunks.length ? await judge(deps.jev, issue ? await deps.linear.getIssue(issue) : null, hunks) : [];
  const flagged = findings ?? hunks.map((h): Finding => ({ ...h, p: null, reason: 'Jev did not answer' }));
  const state = flagged.length ? 'failure' : 'success';
  const description = !hunks.length
    ? 'No existing test changed'
    : findings === null
      ? "Jev did not answer: the owner's decision is needed"
      : flagged.length
        ? `${flagged.length} test change(s) need the owner's decision`
        : `${hunks.length} test change(s), all sanctioned`;

  await env.DB.prepare(
    `INSERT INTO integrity (repo, sha, installation_id, pr, title, issue, state, findings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo, sha) DO UPDATE SET installation_id = excluded.installation_id, pr = excluded.pr, title = excluded.title, issue = excluded.issue, state = excluded.state, findings = excluded.findings, created_at = excluded.created_at`,
  )
    .bind(repository.full_name, sha, installation.id, pr.number, pr.title, issue, state, JSON.stringify(flagged), new Date().toISOString())
    .run();
  await deps.github.setStatus(installation.id, owner, repo, sha, { state, description, targetUrl });
  await audit.record(env.DB, { action: `github/${CONTEXT}`, input: { repo: repository.full_name, pr: pr.number, sha, issue, hunks: hunks.length }, jev: flagged, outcome: state, response: { description } });
  if (state === 'failure') await commentSafely(deps.github, installation.id, owner, repo, pr.number, redComment(pr.user.login, sha, description, flagged, targetUrl));
}

const short = (sha: string) => sha.slice(0, 7);

/** The status and the record are what count; a comment that fails is logged, not retried. */
async function commentSafely(gh: GitHub, installationId: number, owner: string, repo: string, pr: number, body: string) {
  try {
    await gh.comment(installationId, owner, repo, pr, body);
  } catch (e) {
    console.error('test-integrity comment failed', `${owner}/${repo}#${pr}`, e);
  }
}

/** Mentions the PR's author, so GitHub notifies them. */
function redComment(author: string, sha: string, description: string, flagged: Finding[], url: string) {
  const lines = flagged.map((f) => `- \`${f.file}\`${f.p === null ? '' : ` (sanctioned p=${f.p})`}: ${f.reason}`);
  return [`@${author} **test-integrity** on ${short(sha)}: ${description}.`, '', ...lines, '', `Approve or reject: ${url}`].join('\n');
}

function decisionStatus(env: Env, row: IntegrityRow): Status {
  const targetUrl = approveUrl(env, row.repo, row.sha);
  return row.state === 'approved'
    ? { state: 'success', description: `Approved by ${row.decided_by}`, targetUrl }
    : { state: 'failure', description: `Rejected by the owner${row.reason ? `: ${row.reason}` : ''}`, targetUrl };
}

export interface IntegrityRow {
  repo: string;
  sha: string;
  installation_id: number;
  pr: number;
  title: string;
  issue: string | null;
  state: string;
  findings: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
}

export const getRow = (db: D1Database, repo: string, sha: string) => db.prepare('SELECT * FROM integrity WHERE repo = ? AND sha = ?').bind(repo, sha).first<IntegrityRow>();

/**
 * The owner's decision on one commit. Approve: the status turns green for that commit only. Reject: it stays red, and
 * the App comments on the PR with the reason so the agent working on it sees it.
 */
export async function decide(env: Env, gh: GitHub, row: IntegrityRow, d: { by: string; approve: boolean; reason?: string }): Promise<void> {
  const decided: IntegrityRow = { ...row, state: d.approve ? 'approved' : 'rejected', decided_by: d.by, decided_at: new Date().toISOString(), reason: d.reason?.trim() || null };
  const [owner, repo] = row.repo.split('/');
  await env.DB.prepare('UPDATE integrity SET state = ?, decided_by = ?, decided_at = ?, reason = ? WHERE repo = ? AND sha = ?')
    .bind(decided.state, decided.decided_by, decided.decided_at, decided.reason, row.repo, row.sha)
    .run();
  await gh.setStatus(row.installation_id, owner, repo, row.sha, decisionStatus(env, decided));
  if (!d.approve) {
    const body = [`The owner **rejected** the test changes in ${short(row.sha)}.`, decided.reason ? `\n> ${decided.reason.replace(/\n/g, '\n> ')}` : '', '\nRevert or rework them, then push; the new commit is checked again.'].join('\n');
    await commentSafely(gh, row.installation_id, owner, repo, row.pr, body);
  }
  await audit.record(env.DB, { action: `${d.approve ? 'approve' : 'reject'}/${CONTEXT}`, input: { repo: row.repo, sha: row.sha, pr: row.pr, reason: decided.reason }, outcome: decided.state, response: { by: d.by } });
}
