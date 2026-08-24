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
      listComments: (p: any) => Promise<{ data: PrComment[] }>;
      createComment: (p: any) => Promise<unknown>;
    };
    pulls: {
      listFiles: (p: any) => Promise<{ data: unknown[] }>;
      createReview: (p: any) => Promise<unknown>;
      get: (p: any) => Promise<{ data: any }>;
    };
  };
}
