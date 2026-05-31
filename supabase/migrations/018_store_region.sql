-- ============================================================
-- Migration 018: Store region
-- ============================================================
-- Adds an optional region to stores and seeds real stores by POS code.
-- Test stores (HN-A, HCM-B, DN-C) are left NULL → shown as "Chưa gán".
-- Idempotent: ADD COLUMN IF NOT EXISTS; UPDATEs are safe to re-run.
-- ============================================================

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS region text;

-- Named constraint, added only if missing (survives column-already-exists case)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stores_region_check'
      AND conrelid = 'public.stores'::regclass
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_region_check
      CHECK (region IN ('north', 'central', 'south'));
  END IF;
END $$;

-- North
UPDATE public.stores SET region = 'north'
  WHERE code IN ('POS0063', 'POS0064', 'POS0065', 'POS0077', 'POS0085');

-- Central
UPDATE public.stores SET region = 'central'
  WHERE code IN ('POS0009');

-- South = all remaining REAL stores (POS####) not already assigned.
-- Excludes test stores whose codes are not in POS#### format.
UPDATE public.stores SET region = 'south'
  WHERE region IS NULL AND code LIKE 'POS%';
