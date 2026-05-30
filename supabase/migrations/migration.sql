-- Migration Script for Existing Dormitory Management System
-- Run this script on your EXISTING database to make it compatible with the new application.
-- This script will NOT delete any of your existing data in the 'tenants' or 'invoices' table.

-- 1. Create custom ENUM type for invoice status if it doesn't exist.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status') THEN
        CREATE TYPE public.invoice_status AS ENUM ('draft', 'pending', 'partial', 'verifying', 'paid', 'overdue', 'cancelled');
    END IF;
END$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status') THEN
        IF NOT EXISTS (
            SELECT 1
            FROM pg_enum
            WHERE enumtypid = 'public.invoice_status'::regtype
              AND enumlabel = 'partial'
        ) THEN
            ALTER TYPE public.invoice_status ADD VALUE 'partial';
        END IF;
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
ADD COLUMN IF NOT EXISTS custom_receipt_profile JSONB,
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active',
ADD COLUMN IF NOT EXISTS address TEXT,
ADD COLUMN IF NOT EXISTS lease_months INT,
ADD COLUMN IF NOT EXISTS initial_electricity_reading NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS initial_water_reading NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS advance_rent_amount NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS security_deposit_amount NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS deposit_slip_url TEXT,
ADD COLUMN IF NOT EXISTS advance_rent_slip_url TEXT,
ADD COLUMN IF NOT EXISTS final_electricity_reading NUMERIC(10, 2),
ADD COLUMN IF NOT EXISTS final_water_reading NUMERIC(10, 2),
ADD COLUMN IF NOT EXISTS forfeit_security_deposit BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS policy_accepted BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS policy_accepted_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS policy_version TEXT;

COMMENT ON COLUMN public.tenants.custom_payment_method IS 'Overrides default payment method. {"type": "bank", "details": {...}} or {"type": "qr", "url": "..."}';
COMMENT ON COLUMN public.tenants.custom_receipt_profile IS 'Optional corporate receipt profile override for this tenant/room.';

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
CREATE INDEX IF NOT EXISTS idx_invoice_carry_forwards_target ON public.invoice_carry_forwards(target_invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payment_allocations_batch ON public.invoice_payment_allocations(payment_batch_id);
CREATE INDEX IF NOT EXISTS idx_invoice_arrears_snapshots_target ON public.invoice_arrears_snapshots(target_invoice_id);
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
ADD COLUMN IF NOT EXISTS ui_language TEXT DEFAULT 'th',
ADD COLUMN IF NOT EXISTS role_permissions JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS billing_day INT DEFAULT 1,
ADD COLUMN IF NOT EXISTS due_day INT DEFAULT 5,
ADD COLUMN IF NOT EXISTS late_fee_start_day INT DEFAULT 6,
ADD COLUMN IF NOT EXISTS late_fee_per_day NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS additional_fees JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS additional_discounts JSONB DEFAULT '[]'::jsonb;

ALTER TABLE public.invoices
ADD COLUMN IF NOT EXISTS additional_fees_total NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS additional_fees_breakdown JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS discount_breakdown JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS late_fee_amount NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS late_fee_per_day NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS late_fee_start_date DATE,
ADD COLUMN IF NOT EXISTS carry_forward_amount NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(10, 2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS payment_history JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS opened_count INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS first_opened_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.invoice_carry_forwards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    target_invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT invoice_carry_forwards_source_unique UNIQUE (source_invoice_id)
);

CREATE TABLE IF NOT EXISTS public.invoice_payment_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_batch_id UUID NOT NULL,
    trigger_invoice_id UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
    invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
    paid_at TIMESTAMPTZ NOT NULL,
    slip_url TEXT,
    source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoice_arrears_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    target_invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    snapshot_as_of DATE NOT NULL,
    principal_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
    late_fee_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
    days_overdue INT NOT NULL DEFAULT 0,
    daily_rate NUMERIC(10, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS public.receipt_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label TEXT NOT NULL DEFAULT '',
    company_name TEXT NOT NULL DEFAULT '',
    tax_id TEXT,
    branch TEXT,
    address TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.room_tenant_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    tenant_id UUID,
    tenant_name TEXT NOT NULL,
    move_in_date DATE NOT NULL,
    move_out_date DATE,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'room_tenant_logs_room_tenant_movein_unique'
          AND conrelid = 'public.room_tenant_logs'::regclass
    ) THEN
        ALTER TABLE public.room_tenant_logs
        ADD CONSTRAINT room_tenant_logs_room_tenant_movein_unique
        UNIQUE (room_id, tenant_id, move_in_date);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.move_out_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    requested_move_out_date DATE NOT NULL,
    approved_move_out_date DATE,
    actual_move_out_date DATE,
    status TEXT NOT NULL DEFAULT 'requested',
    request_note TEXT,
    admin_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_move_out_requests_tenant_id ON public.move_out_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_move_out_requests_status ON public.move_out_requests(status);
CREATE INDEX IF NOT EXISTS idx_move_out_requests_requested_date ON public.move_out_requests(requested_move_out_date);

INSERT INTO public.room_tenant_logs (room_id, tenant_id, tenant_name, move_in_date, move_out_date)
SELECT
  t.room_id,
  t.id,
  t.full_name,
  t.move_in_date,
  t.move_out_date
FROM public.tenants t
WHERE t.room_id IS NOT NULL
  AND t.move_in_date IS NOT NULL
ON CONFLICT (room_id, tenant_id, move_in_date) DO NOTHING;

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

ALTER TABLE public.settings
ADD COLUMN IF NOT EXISTS global_discount NUMERIC(10, 2) DEFAULT 0;

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

-- 13. LINE meter webhook user registry
CREATE TABLE IF NOT EXISTS public.line_meter_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    line_user_id TEXT NOT NULL UNIQUE,
    display_name TEXT,
    picture_url TEXT,
    source_channel TEXT,
    last_event_type TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_line_meter_users_last_seen_at
ON public.line_meter_users(last_seen_at DESC);

-- End of migration script.
