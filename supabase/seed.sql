-- Dev seed data (run after creating auth users manually in Supabase dashboard)
-- Replace UUIDs with real auth.users IDs

-- Stores
INSERT INTO public.stores (id, name, code, address) VALUES
  ('11111111-0000-0000-0000-000000000001', 'Store A - Hanoi',   'HN-A', '123 Ba Dinh, Hanoi'),
  ('11111111-0000-0000-0000-000000000002', 'Store B - HCMC',    'HCM-B', '456 District 1, HCMC'),
  ('11111111-0000-0000-0000-000000000003', 'Store C - Danang',  'DN-C', '789 Hai Chau, Danang')
ON CONFLICT (id) DO NOTHING;

-- Note: users are created via auth.users trigger.
-- Create users in Supabase Auth dashboard with these metadata:
-- Admin:         { "full_name": "Admin User",    "role": "admin" }
-- Store Manager: { "full_name": "Manager A",     "role": "store_manager", "store_id": "11111111-0000-0000-0000-000000000001" }
-- Staff:         { "full_name": "Staff Member 1","role": "staff",         "store_id": "11111111-0000-0000-0000-000000000001" }
