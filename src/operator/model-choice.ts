/**
 * Pure policy for `/model`: which of the SDK's live `supportedModels()` a
 * given person may pick. Everyone gets Sonnet models (so a newer Sonnet shows
 * up for them with no code change); only the admin sees the rest (Opus,
 * Haiku, ...). Enforced here, operator-side — the runner just applies
 * whatever valid model it's told to.
 */
import type { ModelChoice } from '../shared/types.js';

export function isSonnet(model: ModelChoice): boolean {
  return /sonnet/i.test(model.id);
}

export function selectableModels(models: ModelChoice[], isAdmin: boolean): ModelChoice[] {
  return isAdmin ? models : models.filter(isSonnet);
}

/** Matches an exact id or display name, case-insensitively — `selectable` is already policy-filtered, so a hit is always allowed. */
export function findModel(selectable: ModelChoice[], query: string): ModelChoice | undefined {
  const q = query.toLowerCase();
  return selectable.find((m) => m.id.toLowerCase() === q || m.displayName.toLowerCase() === q);
}
