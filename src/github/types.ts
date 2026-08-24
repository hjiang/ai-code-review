/**
 * Minimal structural type for the subset of the GitHub REST API this action
 * uses, so modules can be unit-tested with plain mocks.
 */

export interface PrComment {
  id: number;
  user?: { login?: string } | null;
  body?: string;
}

export interface InlineComment {
  path: string;
  body: string;
  side: 'RIGHT';
  line: number;
}

export interface MinimalOctokit {
  rest: {
    issues: {
      listComments: (p: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{ data: PrComment[] }>;
      createComment: (p: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;
    };
    pulls: {
      listFiles: (p: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{ data: unknown[] }>;
      createReview: (p: Record<string, unknown>) => Promise<unknown>;
      get: (p: { owner: string; repo: string; pull_number: number }) => Promise<{
        data: { head: { sha: string }; draft: boolean; title: string; body: string | null };
      }>;
    };
  };
}
