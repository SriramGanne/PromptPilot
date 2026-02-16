import { createClient } from "@supabase/supabase-js";

/**
 * Shared Supabase client for server-side API routes.
 * Uses service role key — never expose this on the client side.
 */
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
