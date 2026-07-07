// Module "Quản lý FS" · "Quản lý sản phẩm" — shared constants.
// Handoff: docs/plan-fs-product-module.md (+ Amendment v2).

// Dept Policy — admins of this department manage the FS module (mirror of the
// Cycle Count gating pattern). Keep in sync with the departments table.
export const POLICY_DEPT_ID = 'fd691349-a087-4998-9536-bc20b14b99b2'

// Photo boxes per product: 1..5. Box 1+2 required (min 2 photos), 3-5 optional,
// box 5 intentionally unnamed (stakeholder). slug feeds the GCS filename:
//   <product_id>_<slug>[_<uniq>] e.g. 2005946_mat_truoc_x1y2.jpg
export const FS_PHOTO_BOXES: { key: 1 | 2 | 3 | 4 | 5; label: string; slug: string; required: boolean }[] = [
  { key: 1, label: 'Ảnh mặt trước', slug: 'mat_truoc', required: true },
  { key: 2, label: 'Ảnh mặt sau',   slug: 'mat_sau',   required: true },
  { key: 3, label: 'Ảnh mặt bên',   slug: 'mat_ben_1', required: false },
  { key: 4, label: 'Ảnh mặt bên',   slug: 'mat_ben_2', required: false },
  { key: 5, label: 'Ảnh khác',      slug: 'khac',      required: false },
]
export const FS_MIN_PHOTOS = 2
export const FS_MAX_PHOTOS = 5

// Dimensions are integer millimetres, required on every item (stakeholder).
export const FS_DIM_MAX_MM = 3000
export const FS_DIM_HINT = 'Nhập theo mm (1cm = 10mm) — vui lòng không nhầm sang cm.'
