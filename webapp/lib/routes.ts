// Role-based default landing route.
// Staff (dược sĩ) land directly on the "new prescription" form so they can
// submit straight away; everyone else (admin / store_manager / unknown) on tasks.
// This only affects the *default* landing — staff can still open /prescriptions
// manually to view past submissions (no forced redirect there).
// /dashboard is kept as an explicit "Tổng quan" report page, not the default.
export function getDefaultRoute(role: string | null | undefined): string {
  return role === 'staff' ? '/prescriptions/new' : '/tasks'
}
