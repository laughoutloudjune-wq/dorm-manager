-- v_room_reconciliation is a simple diagnostic join (rooms vs active
-- tenants) with no need to run with elevated privileges -- security_invoker
-- makes it run as the querying user instead of its creator (lint: ERROR,
-- security_definer_view).
ALTER VIEW public.v_room_reconciliation SET (security_invoker = true);

-- calculate_progressive_utility never references an unqualified
-- user-schema object, but pinning search_path is standard hardening for
-- any SQL/plpgsql function regardless (lint: WARN, function_search_path_mutable).
ALTER FUNCTION public.calculate_progressive_utility(numeric, jsonb) SET search_path = '';
