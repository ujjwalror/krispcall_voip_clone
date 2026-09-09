import { createClient } from '@supabase/supabase-js';
import { Database } from '../types/database.types';

/**
 * Creates an administrative Supabase client using the SECRET KEY.
 * IMPORTANT: This client bypasses Row Level Security (RLS).
 * MUST NEVER BE IMPORTED OR EXPOSED IN BROWSER/CLIENT COMPONENTS.
 */
export function createAdminClient() {
  if (typeof window !== 'undefined') {
    throw new Error('Security Error: createAdminClient cannot be executed in browser context.');
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secretKey) {
    console.warn('Warning: SUPABASE_SECRET_KEY is not defined in environment variables.');
  }

  return createClient<Database>(
    supabaseUrl,
    secretKey || 'placeholder-secret-key',
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
