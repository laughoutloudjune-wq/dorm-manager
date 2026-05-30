-- Date the tenant gave notice (Thailand calendar day), distinct from requested_move_out_date.
ALTER TABLE public.move_out_requests
ADD COLUMN IF NOT EXISTS notice_date DATE;

UPDATE public.move_out_requests
SET notice_date = (created_at AT TIME ZONE 'Asia/Bangkok')::date
WHERE notice_date IS NULL;
