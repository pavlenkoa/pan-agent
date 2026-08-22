import { describe, expect, it } from 'vitest';

import { emptyPeopleIndex } from '../shared/types.js';
import { slugifyForPerson, uniqueSlug } from './provisioning.js';

describe('slugifyForPerson', () => {
  it('lowercases and hyphenates a plain name', () => {
    expect(slugifyForPerson('Andrii Pavlenko', 1)).toBe('andrii-pavlenko');
  });

  it('strips combining diacritics', () => {
    expect(slugifyForPerson('José', 1)).toBe('jose');
  });

  it('prefixes with p- when the cleaned name starts with a digit', () => {
    expect(slugifyForPerson('007', 1)).toBe('p-007');
  });

  it('falls back to person-<id> when nothing Latin/numeric survives (e.g. Cyrillic-only)', () => {
    expect(slugifyForPerson('Марта', 42)).toBe('person-42');
  });

  it('falls back to person-<id> for an empty name', () => {
    expect(slugifyForPerson('', 42)).toBe('person-42');
  });
});

describe('uniqueSlug', () => {
  it('returns the base slug when free', () => {
    const idx = emptyPeopleIndex();
    expect(uniqueSlug(idx, 'andrii', 111)).toBe('andrii');
  });

  it('appends the last 4 digits of the telegram id on collision', () => {
    const idx = emptyPeopleIndex();
    idx.people['andrii'] = {
      telegramUserId: 999,
      chatId: 999,
      status: 'active',
      tz: 'Europe/Warsaw',
      createdAt: '',
      lastSeenAt: '',
    };
    expect(uniqueSlug(idx, 'andrii', 1234567890)).toBe('andrii-7890');
  });

  it('falls back to the full id when even the short-suffixed slug collides', () => {
    const idx = emptyPeopleIndex();
    const entry = { telegramUserId: 0, chatId: 0, status: 'active' as const, tz: '', createdAt: '', lastSeenAt: '' };
    idx.people['andrii'] = entry;
    idx.people['andrii-7890'] = entry;
    expect(uniqueSlug(idx, 'andrii', 1234567890)).toBe('andrii-1234567890');
  });
});
