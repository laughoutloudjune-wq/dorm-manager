/**
 * Returns a new object containing only the given keys from `source` (when
 * present on it). Use this whenever a client-supplied request body gets
 * written into a database row — never spread a raw payload directly into
 * `.insert()`/`.update()`, since that lets a caller set any column the table
 * has, not just the ones the calling UI actually exposes. See
 * docs/audit/2026-09-29-system-audit-detailed.md finding H12.
 */
export function pickFields(source: any, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!source || typeof source !== "object") return result;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = source[key];
    }
  }
  return result;
}
