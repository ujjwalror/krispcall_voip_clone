import { createClient } from '@/lib/supabase/client';

/**
 * Database Service Layer Abstraction
 * Provides unified helper functions for application database health checks and tenant context.
 */

export function getDatabaseStatus() {
  const isConfigured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_URL !== 'https://placeholder.supabase.co' &&
    (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  );

  return {
    configured: isConfigured,
    message: isConfigured
      ? 'Supabase database environment variables configured.'
      : 'Supabase credentials pending in .env.local.',
  };
}

export function getSupabaseClient() {
  return createClient();
}
