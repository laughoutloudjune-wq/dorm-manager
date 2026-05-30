ALTER TABLE public.tenants
ADD COLUMN IF NOT EXISTS forfeit_security_deposit BOOLEAN DEFAULT FALSE;
