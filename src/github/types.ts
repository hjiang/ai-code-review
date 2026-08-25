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

/** Minimal structural subset of a pull-request review comment. */
export interface ReviewComment {
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string | null;
  /** Non-null when this comment is a reply within a thread (not its root). */
  in_reply_to_id?: number | null;
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
      listReviewComments: (p: any) => Promise<{ data: ReviewComment[] }>;
    };
    repos: {
      get: (p: any) => Promise<{ data: any }>;
    };
  };
}
