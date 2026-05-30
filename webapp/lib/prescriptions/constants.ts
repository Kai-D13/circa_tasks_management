// Shared prescription constants — safe to import from both client and server.
// MVP uses the existing public 'task-uploads' bucket with a 'prescriptions/' prefix.
// Swap to a private 'prescription-uploads' bucket + signed URLs in a later sprint.
export const PRESCRIPTION_BUCKET = 'task-uploads'

export const PRESCRIPTION_MAX_IMAGES = 10
export const PRESCRIPTION_MAX_SIZE   = 5 * 1024 * 1024 // 5MB
export const PRESCRIPTION_ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']

// DHC order code format, e.g. "DHC00878115"
export const DHC_PATTERN = /^DHC\d+$/
