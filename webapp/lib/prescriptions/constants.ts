// Shared prescription constants — safe to import from both client and server.
// MVP uses the existing public 'task-uploads' bucket with a 'prescriptions/' prefix.
// Swap to a private 'prescription-uploads' bucket + signed URLs in a later sprint.
export const PRESCRIPTION_BUCKET = 'task-uploads'

export const PRESCRIPTION_MAX_IMAGES = 10
export const PRESCRIPTION_MAX_SIZE   = 5 * 1024 * 1024 // 5MB
export const PRESCRIPTION_ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']

// DHC order code format, e.g. "DHC00878115"
// LOOSE pattern — kept for the legacy product-sync path (existing rows predate
// the strict rule and must stay matchable). Do NOT tighten this one.
export const DHC_PATTERN = /^DHC\d+$/

// STRICT pattern for NEW submissions (stakeholder rule 2026-07-04): DHC00 + 6
// digits. Applied client-side (form) AND server-side (submitPrescription).
export const DHC_STRICT_PATTERN = /^DHC00\d{6}$/
export const DHC_FORMAT_HINT = 'Mã DHC gồm DHC00 + 6 chữ số, ví dụ DHC0097848'
