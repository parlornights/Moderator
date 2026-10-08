import { App } from '@octokit/app';
import { createPrivateKey } from 'node:crypto';

import type { Env } from './env';
import type { ChangedFile } from './hunks';

/** A completed `test-integrity` check run. Only the App that creates a check run can write it. */
export interface Check {
  conclusion: 'success' | 'failure' | 'action_required';
  title: string;
  summary: string;
  detailsUrl: string;
}

export interface GitHub {
  verifyWebhook(body: string, signature: string): Promise<boolean>;
  pullFiles(installationId: number, owner: string, repo: string, pr: number): Promise<ChangedFile[]>;
  /** Every author and committer date on the PR's commits. */
  commitDates(installationId: number, owner: string, repo: string, pr: number): Promise<string[]>;
  setCheck(installationId: number, owner: string, repo: string, sha: string, check: Check): Promise<void>;
  comment(installationId: number, owner: string, repo: string, pr: number, body: string): Promise<void>;
}

export const CONTEXT = 'test-integrity';

/**
 * Rebuilds a PEM key pasted into a single-line secret field, where its line breaks were dropped, turned into spaces or
 * written as literal `\n`.
 */
export function normalizePem(pem: string): string {
  const m = pem.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return pem;
  const body = m[2].replace(/\\n|\s/g, '');
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g)?.join('\n')}\n-----END ${m[1]}-----\n`;
}

/** GitHub hands out PKCS#1 keys; WebCrypto, which Octokit uses here, takes PKCS#8. */
const pkcs8 = (pem: string) => {
  const key = normalizePem(pem);
  return key.includes('BEGIN RSA PRIVATE KEY') ? createPrivateKey(key).export({ type: 'pkcs8', format: 'pem' }).toString() : key;
};

export function github(env: Env): GitHub {
  const app = new App({ appId: env.GITHUB_APP_ID, privateKey: pkcs8(env.GITHUB_PRIVATE_KEY ?? ''), webhooks: { secret: env.GITHUB_WEBHOOK_SECRET } });
  return {
    verifyWebhook: (body, signature) => app.webhooks.verify(body, signature),

    async pullFiles(installationId, owner, repo, pr) {
      const octokit = await app.getInstallationOctokit(installationId);
      const files: ChangedFile[] = [];
      for (let page = 1; ; page++) {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', { owner, repo, pull_number: pr, per_page: 100, page });
        files.push(...data.map((f) => ({ filename: f.filename, status: f.status, previousFilename: f.previous_filename, patch: f.patch })));
        if (data.length < 100) return files;
      }
    },

    async commitDates(installationId, owner, repo, pr) {
      const octokit = await app.getInstallationOctokit(installationId);
      const dates: string[] = [];
      for (let page = 1; ; page++) {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', { owner, repo, pull_number: pr, per_page: 100, page });
        for (const c of data) dates.push(...[c.commit.author?.date, c.commit.committer?.date].filter((d): d is string => !!d));
        if (data.length < 100) return dates;
      }
    },

    async setCheck(installationId, owner, repo, sha, check) {
      const octokit = await app.getInstallationOctokit(installationId);
      await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
        owner,
        repo,
        name: CONTEXT,
        head_sha: sha,
        status: 'completed',
        conclusion: check.conclusion,
        details_url: check.detailsUrl,
        output: { title: check.title.slice(0, 255), summary: check.summary.slice(0, 60_000) },
      });
    },

    async comment(installationId, owner, repo, pr, body) {
      const octokit = await app.getInstallationOctokit(installationId);
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: pr, body });
    },
  };
}

/** The manifest GitHub turns into Moderator's App in one click (/github/setup). */
export const appManifest = (publicUrl: string) => ({
  name: 'parlornights-moderator',
  url: publicUrl,
  hook_attributes: { url: `${publicUrl}/github/webhook` },
  redirect_url: `${publicUrl}/github/created`,
  public: false,
  default_permissions: { contents: 'read', pull_requests: 'write', checks: 'write', metadata: 'read' },
  default_events: ['pull_request'],
});

/** Exchanges the one-time code GitHub sends after the App is created for its id, key and webhook secret. */
export async function convertManifest(code: string, fetcher: typeof fetch = fetch) {
  const res = await fetcher(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'moderator' },
  });
  if (!res.ok) throw new Error(`GitHub refused the manifest code: ${res.status}`);
  const app = (await res.json()) as { id: number; slug: string; pem: string; webhook_secret: string; html_url: string };
  return { ...app, pem: pkcs8(app.pem) };
}
