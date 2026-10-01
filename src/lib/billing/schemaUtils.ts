/**
 * Precision helper to distinguish expected pre-migration missing schema/relation/column errors
 * from generic database outages, network errors, timeouts, or permission/RLS failures.
 *
 * Must FAIL CLOSED on:
 * - network failures / timeouts
 * - database outages
 * - permission / RLS errors (e.g. 42501)
 * - authentication / JWT failures
 * - malformed query / constraint violations
 */
export function isExpectedLegacySchemaMissingError(err: any): boolean {
  if (!err) return false;

  const code = String(err.code || err.status || '').trim();
  const message = String(err.message || '').trim().toLowerCase();
  const details = String(err.details || '').trim().toLowerCase();

  // Fail closed on permission / RLS errors
  if (code === '42501' || message.includes('permission denied') || message.includes('violates row-level security policy')) {
    return false;
  }

  // Fail closed on network / connection / timeout errors
  if (
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('connection') ||
    message.includes('econnrefused') ||
    code.startsWith('08')
  ) {
    return false;
  }

  // Fail closed on authentication / JWT failures
  if (code === 'PGRST301' || message.includes('jwt') || message.includes('unauthorized')) {
    return false;
  }

  // Explicit PostgreSQL / PostgREST missing relation or column error codes
  if (
    code === '42P01' || // undefined_table
    code === '42703' || // undefined_column
    code === 'PGRST204' || // column not found
    code === 'PGRST205' || // table / relation not found
    code === 'PGRST100' // schema / endpoint not found
  ) {
    return true;
  }

  // Specific message indicators for missing table/column pre-migration
  if (
    (message.includes('could not find') && (message.includes('column') || message.includes('relation') || message.includes('table'))) ||
    (message.includes('relation') && message.includes('does not exist')) ||
    (message.includes('column') && message.includes('does not exist')) ||
    (details.includes('relation') && details.includes('does not exist')) ||
    (details.includes('column') && details.includes('does not exist'))
  ) {
    return true;
  }

  return false;
}
