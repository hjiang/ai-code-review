import { describe, expect, it } from 'vitest';
import { resolveBotLogin } from '../../src/github/identity.js';
import type { IdentityOctokit } from '../../src/github/identity.js';

function fakeOctokit(login: string | undefined, error?: Error): IdentityOctokit {
  return {
    rest: {
      users: {
        getAuthenticated: () =>
          error ? Promise.reject(error) : Promise.resolve({ data: { login } })
      }
    }
  } as IdentityOctokit;
}

describe('resolveBotLogin', () => {
  it('returns the token identity when getAuthenticated succeeds', async () => {
    expect(await resolveBotLogin(fakeOctokit('github-actions[bot]'), 'issue_comment', 'alice')).toBe(
      'github-actions[bot]'
    );
    expect(await resolveBotLogin(fakeOctokit('github-actions[bot]'), 'pull_request', 'alice')).toBe(
      'github-actions[bot]'
    );
  });

  it('returns "" on issue_comment when identity cannot be resolved (never the actor)', async () => {
    // Regression: on issue_comment the actor IS the comment author, so an actor
    // fallback makes the loop guard silently drop every human /review comment.
    const warns: string[] = [];
    const login = await resolveBotLogin(
      fakeOctokit(undefined, new Error('403')),
      'issue_comment',
      'alice',
      (m) => warns.push(m)
    );
    expect(login).toBe('');
    expect(warns.some((m) => /not using actor/i.test(m))).toBe(true);
  });

  it('falls back to the actor on non-issue_comment events when identity cannot be resolved', async () => {
    expect(await resolveBotLogin(fakeOctokit(undefined, new Error('403')), 'pull_request', 'alice')).toBe('alice');
    expect(await resolveBotLogin(fakeOctokit(undefined, new Error('403')), 'workflow_dispatch', 'alice')).toBe(
      'alice'
    );
  });

  it('returns "" when a successful response omits the login', async () => {
    expect(await resolveBotLogin(fakeOctokit(undefined), 'issue_comment', 'alice')).toBe('');
  });
});
