import { createBrowserClient } from '@supabase/ssr';
import { Database } from '../types/database.types';

/**
 * Creates a browser-side Supabase client using public environment variables.
 * Safe for use inside React Client Components.
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
  const supabasePublishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    'placeholder-publishable-key';

  return createBrowserClient<Database>(supabaseUrl, supabasePublishableKey);
}
