import { describe, expect, it } from 'vitest';
import type { ModelChoice } from '../shared/types.js';
import { findModel, isSonnet, selectableModels } from './model-choice.js';

const m = (id: string, displayName = id): ModelChoice => ({ id, displayName, description: '' });
const ALL = [m('claude-sonnet-5', 'Sonnet 5'), m('claude-sonnet-5-5', 'Sonnet 5.5'), m('claude-opus-5-5', 'Opus 5.5'), m('claude-haiku-5-5')];

describe('selectableModels', () => {
  it('gives non-admins Sonnet models only', () => {
    expect(selectableModels(ALL, false).map((x) => x.id)).toEqual(['claude-sonnet-5', 'claude-sonnet-5-5']);
  });

  it('gives the admin everything', () => {
    expect(selectableModels(ALL, true)).toEqual(ALL);
  });
});

describe('isSonnet', () => {
  it('matches on the model id, not the description', () => {
    expect(isSonnet(m('claude-opus-5-5', 'Sonnet-like Opus'))).toBe(false);
    expect(isSonnet(m('claude-sonnet-6'))).toBe(true);
  });
});

describe('findModel', () => {
  it('matches id or display name case-insensitively', () => {
    expect(findModel(ALL, 'CLAUDE-SONNET-5-5')?.id).toBe('claude-sonnet-5-5');
    expect(findModel(ALL, 'sonnet 5')?.id).toBe('claude-sonnet-5');
  });

  it('returns undefined for a model outside the given list', () => {
    expect(findModel(selectableModels(ALL, false), 'claude-opus-5-5')).toBeUndefined();
  });
});
