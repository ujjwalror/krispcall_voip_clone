import 'server-only';

/**
 * Bounded timeout helper for server-side READ-ONLY provider network calls.
 * Prevents provider latency from hanging server routes indefinitely.
 * 
 * ⚠️ WARNING: THIS TIMEOUT/FALLBACK PATTERN MUST ONLY BE USED FOR READ-ONLY PROVIDER OPERATIONS.
 * IT MUST NEVER BE REUSED FOR PROVIDER MUTATIONS (such as purchasing numbers, creating bundles,
 * creating end users, uploading documents, charging payment methods, or creating subscriptions).
 * 
 * For provider mutations, a timeout produces an ambiguous state (server times out while provider
 * may have completed the operation). Future mutation architecture requires a durable operation record,
 * database idempotency, provider-resource reconciliation, and explicit pending/unknown status workflows.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let settled = false;
  let timer: NodeJS.Timeout;

  const wrappedPromise = promise
    .then((res) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
      }
      return res;
    })
    .catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        throw err;
      }
      // If the timeout already resolved the race, absorb late promise rejection safely
      console.warn(`[withTimeout] Absorbed late promise rejection after timeout (${timeoutMs}ms):`, err?.message || err);
      return fallback;
    });

  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        console.warn(`[withTimeout] Operation exceeded ${timeoutMs}ms limit. Returning fallback result.`);
        resolve(fallback);
      }
    }, timeoutMs);
  });

  return Promise.race([wrappedPromise, timeoutPromise]);
}

/**
 * Canonical helper for normalizing domain and provider number category strings.
 * Exhaustive normalization:
 * - 'local', 'Local', 'LOCAL' -> 'local'
 * - 'mobile', 'Mobile', 'MOBILE' -> 'mobile'
 * - 'toll_free', 'toll-free', 'tollfree', 'Toll-Free' -> 'toll_free'
 */
export function normalizeNumberType(rawType: string): 'local' | 'mobile' | 'toll_free' {
  const norm = (rawType || '').toLowerCase().trim().replace(/[\s-]/g, '_');
  if (norm === 'tollfree' || norm === 'toll_free') return 'toll_free';
  if (norm === 'mobile') return 'mobile';
  return 'local';
}

