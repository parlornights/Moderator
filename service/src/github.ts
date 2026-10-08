import { App } from '@octokit/app';
import { createPrivateKey } from 'node:crypto';

import type { Env } from './env';
import type { ChangedFile } from './hunks';

export interface Status {
  state: 'success' | 'failure';
  description: string;
  targetUrl: string;
}

export interface GitHub {
  verifyWebhook(body: string, signature: string): Promise<boolean>;
  pullFiles(installationId: number, owner: string, repo: string, pr: number): Promise<ChangedFile[]>;
  setStatus(installationId: number, owner: string, repo: string, sha: string, s: Status): Promise<void>;
}

export const CONTEXT = 'test-integrity';

/** GitHub hands out PKCS#1 keys; WebCrypto, which Octokit uses here, takes PKCS#8. */
const pkcs8 = (pem: string) => (pem.includes('BEGIN RSA PRIVATE KEY') ? createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' }).toString() : pem);

export function github(env: Env): GitHub {
  const app = new App({ appId: env.GITHUB_APP_ID, privateKey: pkcs8(env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n')), webhooks: { secret: env.GITHUB_WEBHOOK_SECRET } });
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

    async setStatus(installationId, owner, repo, sha, s) {
      const octokit = await app.getInstallationOctokit(installationId);
      await octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
        owner,
        repo,
        sha,
        state: s.state,
        context: CONTEXT,
        description: s.description.slice(0, 140),
        target_url: s.targetUrl,
      });
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
  default_permissions: { contents: 'read', pull_requests: 'read', statuses: 'write', metadata: 'read' },
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
