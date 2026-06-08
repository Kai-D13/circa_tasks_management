// Role-based default landing route.
// All roles (staff, store_manager, admin, PIC) land on /tasks.
// Staff can still reach /prescriptions manually from the sidebar.
// /dashboard is kept as an explicit "Tổng quan" report page, not the default.
export function getDefaultRoute(_role: string | null | undefined): string {
  return '/tasks'
}
