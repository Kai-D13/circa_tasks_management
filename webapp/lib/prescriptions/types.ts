// Shared prescription types — importable from client components without
// pulling in the server-action module.

export interface PrescriptionImageInput {
  // storage_path. Supabase uploads store a bucket KEY (prescriptions/<store>/…);
  // GCS uploads (STORAGE_PROVIDER=gcs) store a FULL public URL. Serve paths +
  // submit validation handle both (key vs http URL).
  path: string
  name: string
  type: string
  size: number
}

export interface ProductRow {
  order_code:       string
  product_id:       string
  product_name?:    string
  sku_code:         string
  lot_date:         string
  pos_code?:        string
  pos_name?:        string
  created_at_vn?:   string
  completed_at_vn?: string
  employee_name?:   string
}
