CREATE TABLE IF NOT EXISTS public.tutor_usage_limits (
  scope text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (scope, window_start)
);

ALTER TABLE public.tutor_usage_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tutor_usage_limits FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.consume_tutor_request(
  p_user_id uuid,
  p_limit integer DEFAULT 30
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_count integer;
  current_window timestamptz := date_trunc('hour', now());
BEGIN
  IF p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'Invalid tutor request limit';
  END IF;

  INSERT INTO public.tutor_usage_limits (scope, window_start, request_count)
  VALUES ('global', current_window, 1)
  ON CONFLICT (scope, window_start)
  DO UPDATE SET request_count = public.tutor_usage_limits.request_count + 1
  WHERE public.tutor_usage_limits.request_count < 200
  RETURNING request_count INTO current_count;

  IF current_count IS NULL THEN
    RETURN false;
  END IF;

  current_count := NULL;
  INSERT INTO public.tutor_usage_limits (scope, window_start, request_count)
  VALUES ('user:' || p_user_id::text, current_window, 1)
  ON CONFLICT (scope, window_start)
  DO UPDATE SET request_count = public.tutor_usage_limits.request_count + 1
  WHERE public.tutor_usage_limits.request_count < p_limit
  RETURNING request_count INTO current_count;

  RETURN current_count IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_tutor_request(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_tutor_request(uuid, integer) TO service_role;
