-- Persists which basis ("previous month" vs. "move-in reading") the admin
-- picked for a room's first billing cycle after a tenant moves in.
--
-- The Meters page previously re-derived this choice from scratch on every
-- reload/refetch instead of reading back what was saved: it always defaulted
-- to the move-in reading whenever one existed, silently discarding an admin's
-- explicit "use previous month" choice the moment the page refetched after
-- Save. The numeric previous_electricity/previous_water values were saved
-- correctly each time, but the dropdown (and the next save) would revert to
-- the move-in numbers. Storing the choice explicitly lets the page trust it
-- on reload instead of guessing.
ALTER TABLE public.meter_readings
ADD COLUMN IF NOT EXISTS previous_source TEXT
  CHECK (previous_source IS NULL OR previous_source IN ('move_in', 'prev_month'));
