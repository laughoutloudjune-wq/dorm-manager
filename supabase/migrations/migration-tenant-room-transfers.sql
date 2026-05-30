-- Tenant mid-month room transfer records
-- Run this in Supabase SQL Editor

create table if not exists public.tenant_room_transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  from_room_id uuid not null references public.rooms(id) on delete restrict,
  to_room_id uuid not null references public.rooms(id) on delete restrict,
  transfer_date date not null,
  billing_month date not null,
  old_prev_electricity numeric not null default 0,
  old_curr_electricity numeric not null default 0,
  old_prev_water numeric not null default 0,
  old_curr_water numeric not null default 0,
  new_prev_electricity numeric not null default 0,
  new_curr_electricity numeric not null default 0,
  new_prev_water numeric not null default 0,
  new_curr_water numeric not null default 0,
  old_electric_usage numeric not null default 0,
  old_water_usage numeric not null default 0,
  old_rent_amount numeric not null default 0,
  new_rent_amount numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tenant_room_transfers_tenant_id
  on public.tenant_room_transfers (tenant_id);

create index if not exists idx_tenant_room_transfers_billing_month
  on public.tenant_room_transfers (billing_month);

create unique index if not exists uq_tenant_room_transfers_unique_move
  on public.tenant_room_transfers (tenant_id, to_room_id, transfer_date);
