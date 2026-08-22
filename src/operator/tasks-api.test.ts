import { describe, expect, it } from 'vitest';

import { emptyPeopleIndex, type PeopleIndex } from '../shared/types.js';
import { isAuthorized } from './tasks-api.js';

function idxWith(slug: string, tasksToken: string): PeopleIndex {
  const idx = emptyPeopleIndex();
  idx.people[slug] = {
    telegramUserId: 1,
    chatId: 1,
    status: 'active',
    tz: 'UTC',
    createdAt: '',
    lastSeenAt: '',
    tasksToken,
  };
  return idx;
}

describe('isAuthorized', () => {
  it('accepts the correct bearer token for the claimed slug', () => {
    const idx = idxWith('andrii', 'secret-token');
    expect(isAuthorized(idx, 'andrii', 'Bearer secret-token')).toBe(true);
  });

  it('rejects a token that belongs to a different slug', () => {
    // "andrii" tries to schedule a task claiming to be "marta", presenting their own token.
    const idx = idxWith('andrii', 'andriis-token');
    idx.people['marta'] = { ...idx.people['andrii']!, tasksToken: 'martas-token' };
    expect(isAuthorized(idx, 'marta', 'Bearer andriis-token')).toBe(false);
  });

  it('rejects an unknown slug regardless of token', () => {
    const idx = emptyPeopleIndex();
    expect(isAuthorized(idx, 'ghost', 'Bearer anything')).toBe(false);
  });

  it('rejects a missing Authorization header', () => {
    const idx = idxWith('andrii', 'secret-token');
    expect(isAuthorized(idx, 'andrii', undefined)).toBe(false);
  });

  it('rejects a header without the Bearer prefix', () => {
    const idx = idxWith('andrii', 'secret-token');
    expect(isAuthorized(idx, 'andrii', 'secret-token')).toBe(false);
  });

  it('does not throw on a token length mismatch (timingSafeEqual guard)', () => {
    const idx = idxWith('andrii', 'a-much-longer-secret-token');
    expect(() => isAuthorized(idx, 'andrii', 'Bearer short')).not.toThrow();
    expect(isAuthorized(idx, 'andrii', 'Bearer short')).toBe(false);
  });
});
