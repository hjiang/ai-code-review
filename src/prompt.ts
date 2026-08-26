/**
 * Prompt builders. Pure functions that produce the LLM message pairs for the
 * summary and review modes, each respecting a per-run patch-char budget.
 */

import type { PrFile } from './diff.js';
import type { RepoInfo } from './github/reviews.js';
import type { PreviousComment } from './github/threads.js';

export const SUMMARY_MARKER = '<!-- ai-review:summary -->';

export interface PrSummaryInfo {
  title: string;
  body: string;
}

interface Msg {
  role: 'system' | 'user';
  content: string;
}

/** One-line-per-fact repo context block included in every LLM user message. */
export function buildRepoContext(info: RepoInfo): string {
  const lines = [
    'Repository context:',
    `- repo: ${info.fullName}`,
    `- visibility: ${info.visibility}`,
    info.description ? `- description: ${info.description}` : null,
    `- default branch: ${info.defaultBranch || '(unknown)'}`,
    `- primary language: ${info.language ?? '(unknown)'}`,
    `- fork: ${info.isFork ? 'yes' : 'no'}`,
    `- archived: ${info.isArchived ? 'yes' : 'no'}`
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

const SUMMARY_SYSTEM = `You are a senior software engineer writing a concise, insightful summary of a pull request for the reviewers.
Focus on: what the PR does, the most important changes grouped by area, risk level with justification, and testing gaps.
Do not restate every file. No fluff. Output STRICT JSON only, with exactly this shape:
{"summary_md": "markdown summary text"}
The "summary_md" value is raw markdown (headings, bullets). Reply with JSON only.`;

const REVIEW_SYSTEM = `You are a senior code reviewer performing an automated pull-request review.
Look for REAL issues only: bug risk, security, correctness, error handling, race conditions, API misuse, performance, and maintainability.
Rules:
- Only report genuine issues. No nitpicks or style suggestions unless egregious.
- At most one comment per distinct issue.
- Cite the line number from the NEW side of the diff.
- Skip generated, vendored, and dependency-lock content.
- Every comment must be self-contained markdown: a severity emoji header (🔴 critical / 🟠 warning / 🔵 suggestion), what is wrong, why it matters, and a concrete fix.
- If an issue is listed under "Previously reported issues" in the request, do NOT re-report it, unless the code has changed such that it is a genuinely new and different problem.
Output STRICT JSON only, with exactly this shape:
{"findings": [{"path": string, "line": number, "severity": "critical"|"warning"|"suggestion", "category": string, "comment_md": string, "suggestion_md": string|null}]}
"line" MUST be a line number that exists in the provided diff on the new side.
Example finding:
{"path":"src/auth.ts","line":12,"severity":"critical","category":"security","comment_md":"🔴 **Severity: critical**\\n\\nSQL built by string concatenation is injectable.\\n\\nUse parameterized queries.","suggestion_md":"Use a prepared statement."}
Reply with JSON only.`;

const fileListLine = (f: PrFile): string =>
  `- ${f.filename} (+${f.additions}/-${f.deletions})`;

/** Build the file list + fenced diffs section, truncated to stay in budget. */
function buildFileSection(files: PrFile[], maxChars: number): string {
  const header = `Changed files:\n${files.map(fileListLine).join('\n')}\n\nDiffs:\n`;
  const parts: string[] = [];
  let used = header.length;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const block = `\n### ${f.filename}\n\`\`\`diff\n${f.patch ?? ''}\n\`\`\`\n`;
    if (used + block.length > maxChars) {
      parts.push(`\n[…truncated: ${files.length - i} more file(s) omitted to stay in budget]\n`);
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return header + parts.join('');
}

/** Messages for the one-time PR summary. */
export function buildSummaryMessages(
  pr: PrSummaryInfo,
  files: PrFile[],
  maxPatchChars: number,
  repo: RepoInfo
): Msg[] {
  const user = [
    buildRepoContext(repo),
    '',
    `PR title: ${pr.title}`,
    `PR description:\n${pr.body || '(none)'}`,
    '',
    buildFileSection(files, maxPatchChars)
  ].join('\n');
  return [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: user }
  ];
}

const MAX_PREVIOUS = 30;
const PREVIOUS_BODY_CAP = 120;

/** Compact "previously reported issues" block, capped to stay small. */
function buildPreviousBlock(previous: PreviousComment[]): string {
  const lines: string[] = [];
  for (const c of previous.slice(0, MAX_PREVIOUS)) {
    const at = c.line != null ? `${c.path}:${c.line}` : c.path;
    // Thread bodies are user-authored, hence untrusted prompt input: collapse
    // to a single line and JSON-quote so newlines/markdown cannot break the
    // bullet block or inject prompt instructions.
    const single = c.body.replace(/\s+/g, ' ').trim();
    const short = single.length > PREVIOUS_BODY_CAP ? `${single.slice(0, PREVIOUS_BODY_CAP)}…` : single;
    lines.push(`- ${at} — ${JSON.stringify(short)}`);
  }
  if (previous.length > MAX_PREVIOUS) {
    lines.push(`- …and ${previous.length - MAX_PREVIOUS} more already-reported issue(s) (do not re-report them either)`);
  }
  return [
    '',
    'Previously reported issues (already discussed in this PR\'s inline review threads — do NOT re-report these unless the code changed such that it is a genuinely new problem):',
    ...lines
  ].join('\n');
}

/** Messages for an inline review run. */
export function buildReviewMessages(
  files: PrFile[],
  maxPatchChars: number,
  repo: RepoInfo,
  previous: PreviousComment[] = []
): Msg[] {
  const user = [
    buildRepoContext(repo),
    '',
    buildFileSection(files, maxPatchChars),
    ...(previous.length > 0 ? [buildPreviousBlock(previous)] : [])
  ].join('\n');
  return [
    { role: 'system', content: REVIEW_SYSTEM },
    { role: 'user', content: user }
  ];
}
