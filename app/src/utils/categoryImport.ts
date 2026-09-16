import { normalizeCategoryList } from '../api/RssFeedClient';

/**
 * Parse an imported category list.
 *
 * Accepts the JSON this app exports, and also a plain newline- or
 * comma-separated list, because pasting a list of names is the obvious thing to
 * try and refusing it would be needless friction.
 *
 * Lives outside the component so the component file exports only components.
 */
export function parseCategoryImport(text: string): { names: string[]; format: string } {
  const trimmed = text.trim();
  if (!trimmed) return { names: [], format: 'empty' };

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('That looks like JSON but could not be parsed.');
    }
    // A bare object is accepted as { categories: [...] }, which is what a
    // hand-written config is likely to look like.
    const value = Array.isArray(parsed)
      ? parsed
      : (parsed as { categories?: unknown })?.categories;
    return { names: normalizeCategoryList(value), format: 'JSON' };
  }

  return {
    names: normalizeCategoryList(trimmed.split(/[\r\n,]+/)),
    format: 'plain text',
  };
}
