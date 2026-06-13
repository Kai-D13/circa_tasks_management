// Human-friendly task code for display/monitoring (migration 053).
// The UUID id stays the system key; `seq` is a sequential number rendered as
// "T-001042". PICs reference the short code instead of the UUID.
export function formatTaskCode(seq: number | null | undefined): string {
  if (seq === null || seq === undefined) return ''
  return `T-${String(seq).padStart(6, '0')}`
}
