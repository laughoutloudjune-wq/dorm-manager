-- Tenant rewards/points system.
--
-- point_ledger_entries is the source of truth for a tenant's point balance — the
-- balance is always SUM(points) over rows for a tenant, never a separate mutable
-- counter, so history stays auditable the same way invoice/payment history does.
--
-- tenant_referrals tracks self-reported referrals made at LINE registration time;
-- referral_bonus points are only granted once an admin approves the row (fraud
-- protection), so insertion here never awards points by itself.
--
-- settings.rewards_config holds every admin-tunable rate/cap for the system as a
-- single JSONB blob (points-per-baht ratio, earning rates, bonus amounts, redemption
-- caps, expiry) so new tunables can be added without another migration.

ALTER TABLE public.settings
ADD COLUMN IF NOT EXISTS rewards_config JSONB DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.point_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  points INT NOT NULL,
  reason TEXT NOT NULL,
  reference_type TEXT,
  reference_id UUID,
  baht_equivalent NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  expires_at TIMESTAMPTZ,
  idempotency_key TEXT UNIQUE,
  created_by UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT point_ledger_entries_reason_check CHECK (
    reason IN (
      'rent_on_time',
      'streak_bonus',
      'referral_bonus',
      'milestone_3mo',
      'milestone_1yr',
      'redemption',
      'manual_adjustment'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_point_ledger_entries_tenant_id ON public.point_ledger_entries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_point_ledger_entries_reference ON public.point_ledger_entries(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_point_ledger_entries_created_at ON public.point_ledger_entries(created_at);

CREATE TABLE IF NOT EXISTS public.tenant_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  new_tenant_id UUID NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_referrals_status_check CHECK (status IN ('pending_approval', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_referrals_referrer ON public.tenant_referrals(referrer_tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_referrals_status ON public.tenant_referrals(status);
