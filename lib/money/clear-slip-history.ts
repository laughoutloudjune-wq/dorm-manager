/** Pure: null out the embedded slip_url on every payment_history entry. */
export function clearSlipUrlsFromHistory<T extends Record<string, any>>(history: T[]): T[] {
  return history.map((entry) => (entry?.slip_url ? { ...entry, slip_url: null } : entry));
}
