ALTER TABLE public.invoices
ADD COLUMN waived_late_fee_amount NUMERIC(10,2) DEFAULT 0.00,
ADD COLUMN locked_late_fee_amount NUMERIC(10,2) DEFAULT NULL;
