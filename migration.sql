-- Migration Script for Existing Dormitory Management System
-- Run this script on your EXISTING database to make it compatible with the new application.
-- This script will NOT delete any of your existing data in the 'tenants' or 'invoices' table.

-- 1. Create custom ENUM type for invoice status if it doesn't exist.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status') THEN
        CREATE TYPE public.invoice_status AS ENUM ('draft', 'pending', 'verifying', 'paid', 'overdue', 'cancelled');
    END IF;
END$$;

-- 2. Create 'buildings' table if it doesn't exist.
CREATE TABLE IF NOT EXISTS public.buildings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    address TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 3. Alter 'rooms' table to add building_id if it doesn't exist.
-- This assumes a 'rooms' table already exists. If not, you may need to create it first.
ALTER TABLE public.rooms
ADD COLUMN IF NOT EXISTS building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL;

-- Add room_type and price_month if they don't exist.
ALTER TABLE public.rooms
ADD COLUMN IF NOT EXISTS room_type TEXT,
ADD COLUMN IF NOT EXISTS price_month NUMERIC(10, 2);


-- 4. Alter 'tenants' table to add new columns.
-- This preserves all existing data.
ALTER TABLE public.tenants
ADD COLUMN IF NOT EXISTS custom_payment_method JSONB,
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active',
ADD COLUMN IF NOT EXISTS address TEXT,
ADD COLUMN IF NOT EXISTS lease_months INT,
ADD COLUMN IF NOT EXISTS initial_electricity_reading NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS initial_water_reading NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS advance_rent_amount NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS security_deposit_amount NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS deposit_slip_url TEXT,
ADD COLUMN IF NOT EXISTS final_electricity_reading NUMERIC(10, 2),
ADD COLUMN IF NOT EXISTS final_water_reading NUMERIC(10, 2);

COMMENT ON COLUMN public.tenants.custom_payment_method IS 'Overrides default payment method. {"type": "bank", "details": {...}} or {"type": "qr", "url": "..."}';

-- 5. Alter 'invoices' table to add new columns.
-- This assumes an 'invoices' table already exists.
ALTER TABLE public.invoices
ADD COLUMN IF NOT EXISTS public_token UUID DEFAULT gen_random_uuid(),
ADD COLUMN IF NOT EXISTS slip_url TEXT,
ADD COLUMN IF NOT EXISTS slip_uploaded_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS status invoice_status DEFAULT 'pending' NOT NULL;

-- Add a UNIQUE constraint to public_token if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'invoices_public_token_key' AND conrelid = 'public.invoices'::regclass
    ) THEN
        ALTER TABLE public.invoices ADD CONSTRAINT invoices_public_token_key UNIQUE (public_token);
    END IF;
END$$;

COMMENT ON COLUMN public.invoices.public_token IS 'Secure token for public-facing payment URLs.';
COMMENT ON COLUMN public.invoices.slip_url IS 'URL for the uploaded payment slip.';


-- 6. Create and populate the 'settings' table.
CREATE TABLE IF NOT EXISTS public.settings (
    id INT PRIMARY KEY DEFAULT 1,
    default_payment_method JSONB,
    water_rate NUMERIC(10, 2),
    electricity_rate NUMERIC(10, 2),
    common_fee NUMERIC(10, 2),
    updated_at TIMESTAMPTZ,
    CONSTRAINT single_row_check CHECK (id = 1)
);

-- Insert a default settings row only if the table is empty.
INSERT INTO public.settings (id, water_rate, electricity_rate, common_fee)
SELECT 1, 18.00, 8.00, 100.00
WHERE NOT EXISTS (SELECT 1 FROM public.settings);

-- 7. Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_id ON public.invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_public_token ON public.invoices(public_token);
CREATE INDEX IF NOT EXISTS idx_tenants_line_user_id ON public.tenants(line_user_id);

-- 8. Meter readings table for utility tracking
CREATE TABLE IF NOT EXISTS public.meter_readings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES public.rooms(id) ON DELETE CASCADE NOT NULL,
    reading_month DATE NOT NULL, -- first day of the month
    previous_reading NUMERIC(10, 2) DEFAULT 0.00,
    current_reading NUMERIC(10, 2) DEFAULT 0.00,
    usage NUMERIC(10, 2) DEFAULT 0.00,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE(room_id, reading_month)
);

ALTER TABLE public.meter_readings
ADD COLUMN IF NOT EXISTS previous_electricity NUMERIC(10, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS current_electricity NUMERIC(10, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS electricity_usage NUMERIC(10, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS previous_water NUMERIC(10, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS current_water NUMERIC(10, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS water_usage NUMERIC(10, 2) DEFAULT 0.00;

CREATE INDEX IF NOT EXISTS idx_meter_readings_room_month ON public.meter_readings(room_id, reading_month);

-- 9. Revamp foundation for Web-first billing and settings
ALTER TABLE public.settings
ADD COLUMN IF NOT EXISTS water_min_units NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS water_min_price NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS billing_day INT DEFAULT 1,
ADD COLUMN IF NOT EXISTS due_day INT DEFAULT 5,
ADD COLUMN IF NOT EXISTS late_fee_start_day INT DEFAULT 6,
ADD COLUMN IF NOT EXISTS late_fee_per_day NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS additional_fees JSONB DEFAULT '[]'::jsonb;

ALTER TABLE public.invoices
ADD COLUMN IF NOT EXISTS additional_fees_total NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS additional_fees_breakdown JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS late_fee_amount NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS late_fee_per_day NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS late_fee_start_date DATE;

-- Ensure payment_methods table exists before adding qr_url
CREATE TABLE IF NOT EXISTS public.payment_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label TEXT NOT NULL DEFAULT '',
    bank_name TEXT NOT NULL DEFAULT '',
    account_name TEXT NOT NULL DEFAULT '',
    account_number TEXT NOT NULL DEFAULT '',
    qr_url TEXT,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE public.payment_methods
ADD COLUMN IF NOT EXISTS qr_url TEXT,
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

ALTER TABLE public.invoices
ADD COLUMN IF NOT EXISTS public_token UUID DEFAULT gen_random_uuid();

-- Optional general profile fields used by the Settings page
ALTER TABLE public.settings
ADD COLUMN IF NOT EXISTS dorm_name TEXT,
ADD COLUMN IF NOT EXISTS dorm_address TEXT,
ADD COLUMN IF NOT EXISTS dorm_phone TEXT;

-- 10. Storage bucket for payment slip uploads
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

-- 11. Storage bucket for payment method QR uploads
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

-- 12. Storage bucket for tenant deposit/contract documents
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

-- End of migration script.
