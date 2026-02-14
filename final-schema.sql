-- DormManager Full Reset Schema
-- This script drops existing objects and recreates the complete schema from scratch.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Drop dependent tables first
DROP TABLE IF EXISTS public.meter_readings;
DROP TABLE IF EXISTS public.invoices;
DROP TABLE IF EXISTS public.payment_methods;
DROP TABLE IF EXISTS public.tenants;
DROP TABLE IF EXISTS public.rooms;
DROP TABLE IF EXISTS public.buildings;
DROP TABLE IF EXISTS public.settings;

-- Drop type if exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status') THEN
    DROP TYPE public.invoice_status;
  END IF;
END$$;

-- Custom Types
CREATE TYPE public.invoice_status AS ENUM (
  'draft',
  'pending',
  'partial',
  'verifying',
  'paid',
  'overdue',
  'cancelled'
);

-- Buildings
CREATE TABLE public.buildings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rooms
CREATE TABLE public.rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  room_number TEXT NOT NULL,
  room_type TEXT,
  price_month NUMERIC(10,2),
  status TEXT NOT NULL DEFAULT 'available',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (building_id, room_number)
);

-- Tenants
CREATE TABLE public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES public.rooms(id) ON DELETE RESTRICT,
  full_name TEXT NOT NULL,
  address TEXT,
  phone_number TEXT,
  email TEXT,
  line_user_id TEXT UNIQUE,
  move_in_date DATE NOT NULL,
  move_out_date DATE,
  status TEXT NOT NULL DEFAULT 'active',
  lease_months INT,
  initial_electricity_reading NUMERIC(10,2) DEFAULT 0,
  initial_water_reading NUMERIC(10,2) DEFAULT 0,
  advance_rent_amount NUMERIC(10,2) DEFAULT 0,
  security_deposit_amount NUMERIC(10,2) DEFAULT 0,
  deposit_slip_url TEXT,
  advance_rent_slip_url TEXT,
  final_electricity_reading NUMERIC(10,2),
  final_water_reading NUMERIC(10,2),
  custom_payment_method JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Payment Methods (global)
CREATE TABLE public.payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL DEFAULT '',
  bank_name TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  account_number TEXT NOT NULL DEFAULT '',
  qr_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Settings (single row)
CREATE TABLE public.settings (
  id INT PRIMARY KEY DEFAULT 1,
  dorm_name TEXT,
  dorm_address TEXT,
  dorm_phone TEXT,
  default_payment_method JSONB,
  water_rate NUMERIC(10,2),
  electricity_rate NUMERIC(10,2),
  common_fee NUMERIC(10,2),
  water_min_units NUMERIC DEFAULT 0,
  water_min_price NUMERIC DEFAULT 0,
  billing_day INT DEFAULT 1,
  due_day INT DEFAULT 5,
  late_fee_start_day INT DEFAULT 6,
  late_fee_per_day NUMERIC DEFAULT 0,
  global_discount NUMERIC(10,2) DEFAULT 0,
  additional_fees JSONB DEFAULT '[]'::jsonb,
  additional_discounts JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ,
  CONSTRAINT single_row_check CHECK (id = 1)
);

-- Invoices
CREATE TABLE public.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  rent_amount NUMERIC(10,2) DEFAULT 0.00,
  water_bill NUMERIC(10,2) DEFAULT 0.00,
  electricity_bill NUMERIC(10,2) DEFAULT 0.00,
  common_fee NUMERIC(10,2) DEFAULT 0.00,
  discount_amount NUMERIC(10,2) DEFAULT 0.00,
  discount_breakdown JSONB DEFAULT '[]'::jsonb,
  late_fee_amount NUMERIC(10,2) DEFAULT 0.00,
  late_fee_per_day NUMERIC(10,2) DEFAULT 0.00,
  late_fee_start_date DATE,
  other_fees JSONB,
  additional_fees_total NUMERIC DEFAULT 0,
  additional_fees_breakdown JSONB DEFAULT '[]'::jsonb,
  total_amount NUMERIC(10,2) NOT NULL,
  paid_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  payment_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  status public.invoice_status NOT NULL DEFAULT 'draft',
  public_token UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  slip_url TEXT,
  slip_uploaded_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Meter Readings (supports legacy and dual meters)
CREATE TABLE public.meter_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  reading_month DATE NOT NULL,
  previous_reading NUMERIC(10,2) DEFAULT 0.00,
  current_reading NUMERIC(10,2) DEFAULT 0.00,
  usage NUMERIC(10,2) DEFAULT 0.00,
  previous_electricity NUMERIC(10,2) DEFAULT 0.00,
  current_electricity NUMERIC(10,2) DEFAULT 0.00,
  electricity_usage NUMERIC(10,2) DEFAULT 0.00,
  previous_water NUMERIC(10,2) DEFAULT 0.00,
  current_water NUMERIC(10,2) DEFAULT 0.00,
  water_usage NUMERIC(10,2) DEFAULT 0.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, reading_month)
);

-- Seed default settings row
INSERT INTO public.settings (
  id,
  water_rate,
  electricity_rate,
  common_fee,
  water_min_units,
  water_min_price,
  billing_day,
  due_day,
  late_fee_start_day,
  late_fee_per_day,
  global_discount,
  additional_fees,
  additional_discounts
)
VALUES (1, 18.00, 8.00, 100.00, 0, 0, 1, 5, 6, 0, 0, '[]'::jsonb, '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rooms_building_id ON public.rooms(building_id);
CREATE INDEX IF NOT EXISTS idx_tenants_room_id ON public.tenants(room_id);
CREATE INDEX IF NOT EXISTS idx_tenants_line_user_id ON public.tenants(line_user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_id ON public.invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_room_id ON public.invoices(room_id);
CREATE INDEX IF NOT EXISTS idx_invoices_public_token ON public.invoices(public_token);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON public.invoices(status);
CREATE INDEX IF NOT EXISTS idx_meter_readings_room_month ON public.meter_readings(room_id, reading_month);

-- Storage bucket for payment slip uploads
INSERT INTO storage.buckets (id, name, public)
VALUES ('payment_slips', 'payment_slips', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'payment_slips_public_insert'
  ) THEN
    CREATE POLICY payment_slips_public_insert
    ON storage.objects FOR INSERT
    TO public
    WITH CHECK (bucket_id = 'payment_slips');
  END IF;
END
$$;

-- Storage bucket for tenant deposit/contract documents
INSERT INTO storage.buckets (id, name, public)
VALUES ('tenant-docs', 'tenant-docs', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'tenant_docs_public_insert'
  ) THEN
    CREATE POLICY tenant_docs_public_insert
    ON storage.objects FOR INSERT
    TO public
    WITH CHECK (bucket_id = 'tenant-docs');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'tenant_docs_public_select'
  ) THEN
    CREATE POLICY tenant_docs_public_select
    ON storage.objects FOR SELECT
    TO public
    USING (bucket_id = 'tenant-docs');
  END IF;
END
$$;

-- Storage bucket for payment method QR uploads
INSERT INTO storage.buckets (id, name, public)
VALUES ('payment-methods', 'payment-methods', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'payment_methods_public_insert'
  ) THEN
    CREATE POLICY payment_methods_public_insert
    ON storage.objects FOR INSERT
    TO public
    WITH CHECK (bucket_id = 'payment-methods');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'payment_methods_public_select'
  ) THEN
    CREATE POLICY payment_methods_public_select
    ON storage.objects FOR SELECT
    TO public
    USING (bucket_id = 'payment-methods');
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'payment_slips_public_select'
  ) THEN
    CREATE POLICY payment_slips_public_select
    ON storage.objects FOR SELECT
    TO public
    USING (bucket_id = 'payment_slips');
  END IF;
END
$$;
