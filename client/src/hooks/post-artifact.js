// PostToolUse (matcher: Artifact). A published page or design canvas belongs to a Linear issue: record the URL as an
// `artifact` event and say so at once. The Stop hook holds the turn until the handoff note ties the URL to an issue.

import { appendEvent, issueId } from '../work.js';

import { context } from './io.js';

export const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/;

/** @param {any} input */
export default async function postArtifact(input) {
  const ti = input.tool_input || {};
  if ((ti.action ?? 'publish') !== 'publish' || ti.asset || !issueId()) return;
  const m = `${ti.url || ''} ${JSON.stringify(input.tool_response ?? '')}`.match(ARTIFACT_URL);
  if (!m) return;
  appendEvent('artifact', { url: m[0] });
  return context(
    'PostToolUse',
    `Published ${m[0]}. It belongs to a Linear issue: find it (list_issues; file one if none exists), add the URL to it (moderator linear update <ID> --link <url> --link-title <title>), and put the URL and the issue id on one line of the handoff note. The Stop hook holds the turn until the note does.`,
  );
}
