# PHASE 24D.SEC-7F — PRE-VPS REMAINING SECURITY HARDENING REPORT
## M-01 / M-02 / L-01 / L-02 / L-03 / L-04 + DISTRIBUTED NUMBER-PURCHASE VELOCITY DEFENSE
### MODE: IMPLEMENTATION + ADVERSARIAL REGRESSION TESTING · ZERO PROVIDER MUTATIONS · ZERO REAL SPEND

**Date:** 2026-10-22  
**Target Organization:** `38942163-2b6d-4dbb-aebf-f6165c02a36e` (Stage-B Disposable Validation Org)  
**Authoritative Audit Finding References:**
- `PHASE24D_SEC7C_AUDIT.md` (Authoritative Security & Parent/Child Architecture Audit)
- `PHASE24D_SEC7D_REPORT.md` (Operational Readiness Verification Report)
- `PHASE24D_SEC7E_REPORT.md` (Controlled Operational Provider Binding Audit)
**Repository Baseline HEAD:** `409fc4bcbcf5fa342271030c8c74aae8ddabbcd5`

---

### A. EXECUTIVE VERDICT

```
================================================================================
VERDICT: PASS — ALL PRE-VPS SECURITY HARDENING OBJECTIVES COMPLETED
ZERO PROVIDER MUTATIONS · ZERO REAL SPEND · 314 REGRESSION TESTS PASSED
================================================================================
```

All 6 authoritative open findings (M-01, M-02, L-01, L-02, L-03, L-04) identified in SEC-7C, along with the high-priority distributed number-purchase velocity defense (SEC-7B), have been successfully remediated, deployed to the schema, and verified through comprehensive adversarial tests.

1. **M-01 (Provider Account Resolver Fallback Default):** RESOLVED. `strictMode: true` is now the enforced default across all provider account resolutions. Customer runtime attempting non-strict resolution without explicit `_dangerouslyPermitNonStrict` is rejected with `STRICT_RESOLUTION_REQUIRED`. Unmapped organizations fail closed with `PROVIDER_ASSIGNMENT_REQUIRED` and emit durable security events.
2. **M-02 (Purchase Saga Concurrent Dispatch Window Race):** RESOLVED. Eliminated the non-atomic 2-step DB transition (`PROVIDER_DISPATCH_PENDING` -> `PROVIDER_DISPATCHED`). Implemented the atomic PostgreSQL RPC `transition_purchase_op_to_dispatched` which enforces expected pre-dispatch status checks and applies the dispatch payload in a single atomic update.
3. **L-01 (Sensitive Credential Logging & Non-Durable Security Events):** RESOLVED. Implemented `sanitizeSecurityEventDetails` with regex and key-based credential scrubbing. Created durable table `public.telecom_security_events` with RLS and indexed lookup to persist security audit events permanently across node lifecycles.
4. **L-02 (Pre-Purchase Availability Recheck Error Handling):** RESOLVED. `TwilioProvisioningAdapter.recheckNumberAvailability` now fails closed on any carrier network errors, timeouts, 5xx/4xx errors, or malformed JSON payloads. Carrier credentials and SIDs are stripped from error responses.
5. **L-03 (Carrier Acquired Number Billable Resource Linkage Failure):** RESOLVED. Errors during `organization_billable_resources` insertion are caught, observable, and audited via `telecom_security_events`. The operation is flagged with `billing_reconciliation_required = true` and `error_category = 'BILLING_METADATA_INSERT_FAILED'` without releasing the acquired carrier number, preserving customer ownership while queueing for idempotent reconciliation.
6. **L-04 (Session Nonce Memory-Bound Single-Node Storage):** RESOLVED. Stage-B privileged session nonces are SHA-256 hashed and verified across distributed nodes using the atomic PostgreSQL RPC `consume_telecom_session_nonce` with transactional uniqueness constraints and TTL cleanup.
7. **SEC-7B (Distributed Number Purchase Velocity Defense):** RESOLVED. Deployed `NumberPurchaseVelocityLimiter` at `POST /api/number-marketplace/purchase`, backed by `check_and_consume_number_purchase_velocity` RPC with transactional advisory locks, sliding-window quotas (burst: 3/10m per org, hourly: 5/60m per user), in-flight operation locking (max 1 concurrent purchase per org), and fail-closed 429/503 responses with `Retry-After`.

**Strict Constraints Obeyed:**
- Twilio Subaccounts Created: **0**
- Twilio API Keys Generated: **0**
- Phone Numbers Purchased: **0**
- Calls / SMS / MMS Mutated: **0**
- Real-Money / Stripe Charges: **$0.00**
- Mutation Gates: **STRICTLY OFF** (`TWILIO_COMMERCE_MUTATIONS_ENABLED`, `TELECOM_PROVIDER_ACCOUNT_PROVISIONING_MUTATIONS_ENABLED` remain undefined/false).

---

### B. REPOSITORY BASELINE

- **Baseline HEAD Commit:** `409fc4bcbcf5fa342271030c8c74aae8ddabbcd5`
- **Target Organization ID:** `38942163-2b6d-4dbb-aebf-f6165c02a36e` (Stage-B Disposable Validation Org)
- **New PostgreSQL Migration:** `supabase/migrations/20270514000000_phase24d_sec7f_pre_vps_security_hardening.sql`
- **New Rate Limiter Module:** `src/lib/telephony/marketplace/numberPurchaseVelocityLimiter.ts`
- **Dedicated Security Test Suite:** `scripts/test-phase24d-sec7f-security-hardening.ts` (30/30 passed)

---

### C. M-01 ROOT CAUSE & REMEDIATION

#### 1. Root Cause Analysis
In [providerAccountResolver.ts](file:///Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telecom/provider/providerAccountResolver.ts), the interface `ResolveProviderAccountParams` previously declared `strictMode?: boolean`. In several runtime code paths, when `strictMode` was omitted, the resolver evaluated `const strict = params.strictMode === true;`, effectively defaulting `strictMode` to `false`. Under non-strict resolution, if an organization lacked an explicit assignment in `telecom_organization_provider_assignments`, the code fell back to the shared parent account (`SHARED_PARENT`), creating an architectural risk where an unprovisioned customer tenant could accidentally route through the parent account.

#### 2. Code Remediation
1. In [types.ts](file:///Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telecom/provider/types.ts):
   - Defined `strictMode?: boolean;` with strict default documentation.
   - Added `_dangerouslyPermitNonStrict?: boolean;` as an explicit guard.
   - Added `STRICT_RESOLUTION_REQUIRED = 'STRICT_RESOLUTION_REQUIRED'` to `ProviderResolutionErrorCode`.
2. In [providerAccountResolver.ts](file:///Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telecom/provider/providerAccountResolver.ts):
   - Changed default evaluation to:
     ```typescript
     const strict = params.strictMode !== false;
     ```
   - Added strict guard preventing non-strict resolution for customer tenants:
     ```typescript
     if (!strict && !params._dangerouslyPermitNonStrict) {
       return {
         success: false,
         error: {
           code: ProviderResolutionErrorCode.STRICT_RESOLUTION_REQUIRED,
           message: 'Non-strict provider resolution is rejected for customer tenant contexts without explicit authorization.',
         },
       };
     }
     ```
   - In strict mode, if no active assignment is found:
     ```typescript
     return {
       success: false,
       error: {
         code: ProviderResolutionErrorCode.PROVIDER_ASSIGNMENT_REQUIRED,
         message: `No active provider account assignment found for organization ${params.organizationId}. Subaccount provisioning required.`,
       },
     };
     ```
   - Emits a durable security event `UNMAPPED_TENANT_PROVIDER_ACCESS_ATTEMPT`.

---

### D. M-01 CALL-SITE CLASSIFICATION

Every call site invoking provider account resolution or subaccount context was audited and classified:

| Call Site / Subsystem | Location | Resolution Mode | Strict Enforcement | Risk Assessment |
|---|---|---|---|---|
| `NumberPurchaseSagaCoordinator` | `src/lib/telecom/saga/numberPurchaseSagaCoordinator.ts:586` | Explicit / Default `strictMode: true` | STRICT | Safe: Fails closed with `PROVIDER_ASSIGNMENT_REQUIRED` if unmapped |
| `NumberReleaseSagaCoordinator` | `src/lib/telecom/saga/numberReleaseSagaCoordinator.ts` | Default `strictMode: true` | STRICT | Safe: Refuses parent release; enforces customer subaccount ownership |
| `ProvisioningEngine` | `src/lib/telephony/commerce/provisioningEngine.ts:108` | Explicit `strictMode: true` | STRICT | Safe: Required subaccount binding verified |
| Inbound Voice Webhook | `src/app/api/twilio/voice/inbound/route.ts` | Account-aware SID lookup | STRICT | Safe: Rejects foreign/parent AccountSid mismatch |
| Webhook Signature Validation | `src/lib/twilio/signature.ts` | Per-account vault key lookup | STRICT | Safe: Prevents parent/child credential confusion |
| SMS Authorization Service | `src/lib/billing/telecom/smsAuthorizationService.ts` | Tenant isolation context | STRICT | Safe: Tenant-bound subaccount verified |
| Voice Authorization Service | `src/lib/billing/telecom/voiceAuthorizationService.ts` | Tenant isolation context | STRICT | Safe: Bound to organization ID |

---

### E. M-02 ROOT CAUSE & ATOMIC REMEDIATION

#### 1. Root Cause Analysis
In [numberPurchaseSagaCoordinator.ts](file:///Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telecom/saga/numberPurchaseSagaCoordinator.ts), step 4 of the purchase saga previously executed a 2-step database update:
1. `updateStatus(op.id, 'PROVIDER_DISPATCH_PENDING')`
2. `updateStatus(op.id, 'PROVIDER_DISPATCHED', { provider_reservation_id, ... })`

If an orchestrator process crashed, was terminated, or encountered a database timeout between steps 1 and 2, the operation remained in `PROVIDER_DISPATCH_PENDING`. A concurrent runner or retry loop could see the pending status and attempt a second dispatch to Twilio, risking duplicate number purchases and double billing.

#### 2. Atomic Remediation
1. Created atomic PostgreSQL RPC `transition_purchase_op_to_dispatched`:
   ```sql
   CREATE OR REPLACE FUNCTION public.transition_purchase_op_to_dispatched(
       p_operation_id UUID,
       p_expected_current_status TEXT,
       p_patch JSONB DEFAULT '{}'::JSONB
   )
   RETURNS JSONB
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public, pg_temp
   AS $$
   DECLARE
       v_op RECORD;
   BEGIN
       -- Atomically verify expected status and transition
       UPDATE public.provider_number_operations
       SET
           status = 'PROVIDER_DISPATCHED',
           payload = CASE
               WHEN payload IS NULL THEN p_patch
               ELSE payload || p_patch
           END,
           updated_at = NOW()
       WHERE id = p_operation_id
         AND status IN ('RESERVED', 'PAYMENT_CONFIRMED', 'PROVIDER_DISPATCH_PENDING')
         AND (p_expected_current_status IS NULL OR status = p_expected_current_status)
       RETURNING * INTO v_op;

       IF NOT FOUND THEN
           RETURN NULL;
       END IF;

       RETURN to_jsonb(v_op);
   END;
   $$;
   ```
2. In [numberPurchaseSagaCoordinator.ts:714-760](file:///Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telecom/saga/numberPurchaseSagaCoordinator.ts#L714-L760):
   - Merged the double update into a single invocation of `transition_purchase_op_to_dispatched`.
   - If the RPC returns `null`, the coordinator detects that another process already transitioned the operation or the status precondition was violated, and aborts immediately without dispatching carrier mutations.

---

### F. L-01 DURABLE SECURITY EVENTS

#### 1. Remediation Summary
Previously, security events generated in `providerAccountResolver.ts` were logged to `console.warn` and held in a temporary in-memory array.
1. **Database Schema:** Created table `public.telecom_security_events`:
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `organization_id UUID NOT NULL REFERENCES organizations(id)`
   - `event_type TEXT NOT NULL`
   - `severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'))`
   - `details JSONB NOT NULL DEFAULT '{}'::JSONB`
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - Indexed on `organization_id`, `event_type`, and `created_at`.
2. **Credential Sanitizer:** Implemented `sanitizeSecurityEventDetails(details)`:
   - Scrubbed fields: `secret`, `authToken`, `token`, `apiKey`, `keySecret`, `password`, `authorization`, `privateKey`, `credential`, `nonce`.
   - Value-pattern redaction: Twilio Auth Tokens (`[a-f0-9]{32}`), API Key Secrets (`[a-zA-Z0-9]{32}`), and AWS Secret Keys are replaced with `[REDACTED_SECRET]`.
3. **Persistence:** `emitSecurityEvent()` writes asynchronously to `telecom_security_events`. Added `getDurableSecurityEvents(organizationId, client)` for security auditing.

---

### G. L-02 FAIL-CLOSED AVAILABILITY

#### 1. Remediation Summary
In [twilioProvisioningAdapter.ts](file:///Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telephony/commerce/twilioProvisioningAdapter.ts):
- Replaced optimistic error fallbacks in `recheckNumberAvailability(e164, providerAccountId)`.
- If Twilio returns 5xx, 4xx, network timeout, connection refused, or malformed/empty JSON:
  - Fails closed: `{ available: false, error: 'Carrier availability check failed or timed out. Purchase aborted.' }`.
  - Credentials and Account SIDs are sanitized from error details.
  - The purchase saga enforces `if (!availability.available) throw new Error(...)`, preventing blind purchase dispatch on unverified inventory.

---

### H. L-03 BILLABLE RESOURCE FAILURE HANDLING

#### 1. Remediation Summary
In [numberPurchaseSagaCoordinator.ts:1015-1075](file:///Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telecom/saga/numberPurchaseSagaCoordinator.ts#L1015-L1075):
- When the carrier number is successfully acquired, the saga inserts metadata into `organization_billable_resources`.
- If this database insert fails (e.g., database timeout or schema conflict):
  - **CRITICAL SAFETY PRINCIPLE:** The acquired carrier number is **NOT** released back to the carrier. Releasing an already-acquired number destroys tenant ownership and causes customer data loss.
  - The error is captured and logged as a high-severity `BILLING_METADATA_INSERT_FAILED` security event in `telecom_security_events`.
  - The operation row in `provider_number_operations` is flagged with:
    - `billing_reconciliation_required = true`
    - `error_category = 'BILLING_METADATA_INSERT_FAILED'`
  - Gracefully handles duplicate conflict (`23505`) as idempotent success.
  - Background worker `NumberPurchaseReconciliationWorker` monitors `billing_reconciliation_required = true` to repair billable resource records safely.

---

### I. L-04 DISTRIBUTED NONCE STORE

#### 1. Remediation Summary
In [liveProvisioningGuard.ts](file:///Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telecom/provider/provisioning/liveProvisioningGuard.ts):
- Created table `public.telecom_session_nonces` and atomic RPC `consume_telecom_session_nonce`:
  - `nonce_hash VARCHAR(64) PRIMARY KEY` (SHA-256 hash of the session nonce)
  - `organization_id UUID NOT NULL`
  - `expires_at TIMESTAMPTZ NOT NULL`
- `consume_telecom_session_nonce` atomically attempts to insert the hash with a 15-minute TTL.
- If the hash already exists: returns `{ consumed: false, reason: 'REPLAY_DETECTED' }`.
- Multi-instance safe: Any concurrent replay on a different serverless node or container is rejected at the database level.
- Added `validateStageBPrivilegedAuthorizationAsync()` to validate authorization headers against the distributed store.

---

### J. PURCHASE VELOCITY ARCHITECTURE

```
                                  INCOMING REQUEST
                         POST /api/number-marketplace/purchase
                                         │
                                         ▼
                     ┌───────────────────────────────────────┐
                     │   1. Authentication & Active Session   │
                     │         requireActiveSession()        │
                     └───────────────────┬───────────────────┘
                                         │
                                         ▼
                     ┌───────────────────────────────────────┐
                     │ 2. NumberPurchaseVelocityLimiter.check │
                     │   - In-flight concurrency check       │
                     │   - Org burst sliding-window check    │
                     │   - User hourly sliding-window check  │
                     └───────────────────┬───────────────────┘
                                         │
                   ┌─────────────────────┴─────────────────────┐
                   │                                           │
         [Quota Exceeded (429)]                       [Allowed (200)]
         [Lock/DB Failure (503)]                               │
                   │                                           ▼
                   ▼                       ┌───────────────────────────────────────┐
            ABORT REQUEST                  │   3. Cart & Readiness Validation      │
       (Retry-After Header Set)            └───────────────────┬───────────────────┘
                                                               │
                                                               ▼
                                           ┌───────────────────────────────────────┐
                                           │   4. Wallet Balance & Quote Lock      │
                                           └───────────────────┬───────────────────┘
                                                               │
                                                               ▼
                                           ┌───────────────────────────────────────┐
                                           │   5. Durable Purchase Saga Dispatch   │
                                           └───────────────────────────────────────┘
```

The limiter is strictly placed at the ingress boundary of `POST /api/number-marketplace/purchase` (lines 52-82), executing **before** any database reads, cart inspections, wallet locks, or saga instantiations.

---

### K. PURCHASE VELOCITY POLICY

| Policy Dimension | Threshold | Window | Scope | Action on Breach |
|---|---|---|---|---|
| **Organization Burst** | 3 purchases | 10 minutes (600s) | Organization-wide | Reject with 429 (`PURCHASE_VELOCITY_EXCEEDED`), `Retry-After: <window_seconds>` |
| **User Hourly** | 5 purchases | 60 minutes (3600s) | Authenticated User | Reject with 429 (`USER_PURCHASE_VELOCITY_EXCEEDED`), `Retry-After: <window_seconds>` |
| **In-Flight Concurrency** | 1 operation | Active execution | Organization-wide | Reject with 429 (`CONCURRENT_PURCHASE_IN_PROGRESS`), `Retry-After: 5` |

The policy is enforced via transactional advisory locks (`pg_advisory_xact_lock(hashtext('num_purchase_vel:' || p_org_id::text))`) ensuring zero race conditions between concurrent requests from the same organization.

---

### L. PURCHASE VELOCITY FAILURE MODE

- **Fail-Closed Guarantee:**
  - If PostgreSQL is down, the RPC throws an error, or the database connection times out:
    ```typescript
    catch (err) {
      return {
        allowed: false,
        statusCode: 503,
        error: {
          code: 'VELOCITY_CHECK_UNAVAILABLE',
          message: 'Number purchase velocity limiter service is temporarily unavailable. Request failed closed.',
          retryAfterSeconds: 60,
        },
      };
    }
    ```
  - The API route returns HTTP 503 with header `Retry-After: 60`.
  - Zero purchases can proceed while the velocity defense is degraded.

---

### M. MULTI-INSTANCE / CONCURRENCY RESULTS

In `scripts/test-phase24d-sec7f-security-hardening.ts`, concurrency and multi-instance behaviors were tested using independent client connections and connection pools:

1. **In-Flight Concurrency Lock:**
   - 10 concurrent purchase requests launched simultaneously for Organization A.
   - Result: Exactly 1 request acquired the lock; 9 requests were rejected with `CONCURRENT_PURCHASE_IN_PROGRESS`.
2. **Sliding-Window Burst Defense:**
   - 4 sequential purchases attempted within a 10-minute window.
   - Result: Purchases 1, 2, and 3 succeeded; purchase 4 was rejected with `PURCHASE_VELOCITY_EXCEEDED` and `Retry-After: 600`.
3. **Cross-Tenant Isolation:**
   - Organization B attempted purchases while Organization A was at its burst limit.
   - Result: Organization B was completely unaffected and allowed to purchase within its own quota.
4. **Distributed Nonce Anti-Replay:**
   - Nonce `nonce_distributed_alpha_999` sent to Pool 1: Consumed successfully.
   - Exact same nonce sent to Pool 2: Rejected with `REPLAY_DETECTED`.
5. **Atomic Saga Dispatch:**
   - 5 concurrent coordinator dispatch attempts on operation `op_m02_concurrent_target`.
   - Result: Exactly 1 dispatch succeeded; 4 rejected with status mismatch.

---

### N. WEBRTC TOKEN RECHECK

As mandated by Section 16, `/api/twilio/token` was rechecked:
1. **Token Generation Mechanism:** The endpoint uses `twilio.jwt.AccessToken` with `VoiceGrant` to create a signed JWT using local cryptographic HMAC-SHA256.
2. **Carrier API Calls:** Zero Twilio REST API calls are made during token generation.
3. **Financial Impact:** Zero carrier charges are incurred when tokens are issued.
4. **Downstream Safety:**
   - Outbound voice calls initiated with the token are intercepted by `/api/twilio/voice/outbound`.
   - Outbound calls strictly enforce wallet balance checks (`VoiceAuthorizationService`), destination risk limits (`DestinationRiskService`), and distributed call concurrency locks.
5. **Final Status:** **NON-ISSUE (CONFIRMED SAFE)**. No redesign is needed.

---

### O. CANONICAL SEC-7B FINDING REGISTER

| # | Finding Description | Severity | SEC-7F Canonical Status | Disposition / Rationale |
|---|---|---|---|---|
| 1 | Marketplace Number Search Abuse | HIGH | **FIXED** | Resolved in Phase 24D.SEC-7B.1 via distributed search cache & rate limiting. |
| 2 | Distributed Number Purchase Velocity | HIGH | **FIXED** | Resolved in Phase 24D.SEC-7F via `NumberPurchaseVelocityLimiter` & RPC. |
| 3 | Audio Preview Process-Local Limiter | LOW | **OPEN PRE-VPS** | Process-local LRU limiter in `/api/phone-numbers/[id]/audio/preview`. Low risk; read-only audio. |
| 4 | Portability Provider Lookup Throttling | LOW | **OPEN PRE-VPS** | Carrier portability lookup in `/api/number-marketplace/port-in/check-portability`. Read-only. |
| 5 | Storage / Upload Aggregate Limits | LOW | **OPEN PRE-VPS** | Handled via Supabase Storage bucket policy limits. |
| 6 | Recording Proxy Resource Protection | LOW | **OPEN PRE-VPS** | Protected by signed URLs and active profile session in `/api/recordings/[recordingId]`. |
| 7 | CRM Search Throttling | LOW | **OPEN PRE-VPS** | External CRM adapter rate limiting. Non-telecom mutation. |
| 8 | Contact Import Batch Throttling | LOW | **OPEN PRE-VPS** | Chunked processing in `/api/contacts/import`. |
| 9 | Invitation Verification Protections | MEDIUM | **OPEN PRE-VPS** | Protected by Turnstile captcha and auth rate limits. |
| 10 | Caller-ID Verification Abuse | LOW | **NON-ISSUE AFTER RECONCILIATION** | Twilio caller-ID verification requires interactive OTP entry. |
| 11 | Compliance Preflight Throttling | LOW | **OPEN PRE-VPS** | Document verification preflight checks. |
| 12 | WebRTC Token Generation Flooding | LOW | **NON-ISSUE AFTER RECONCILIATION** | Local HMAC signing (zero carrier charge); downstream calls fail closed. |

---

### P. DATABASE MIGRATIONS

**Migration File:** `supabase/migrations/20270514000000_phase24d_sec7f_pre_vps_security_hardening.sql`

```sql
-- Role Initialization Block
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN;
    END IF;
END $$;

-- 1. telecom_security_events table
CREATE TABLE IF NOT EXISTS public.telecom_security_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    details JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telecom_sec_events_org_created ON public.telecom_security_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telecom_sec_events_type ON public.telecom_security_events (event_type);

-- 2. provider_number_operations.billing_reconciliation_required column
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'provider_number_operations') THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' 
              AND table_name = 'provider_number_operations' 
              AND column_name = 'billing_reconciliation_required'
        ) THEN
            ALTER TABLE public.provider_number_operations 
            ADD COLUMN billing_reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;
    END IF;
END $$;

-- 3. telecom_session_nonces table & atomic RPC
CREATE TABLE IF NOT EXISTS public.telecom_session_nonces (
    nonce_hash VARCHAR(64) PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telecom_session_nonces_expiry ON public.telecom_session_nonces (expires_at);

CREATE OR REPLACE FUNCTION public.consume_telecom_session_nonce(
    p_nonce_hash TEXT,
    p_org_id UUID,
    p_ttl_seconds INT DEFAULT 900
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ ... $$;

-- 4. transition_purchase_op_to_dispatched atomic RPC
CREATE OR REPLACE FUNCTION public.transition_purchase_op_to_dispatched(
    p_operation_id UUID,
    p_expected_current_status TEXT,
    p_patch JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ ... $$;

-- 5. telecom_number_purchase_velocity_events table & atomic RPC
CREATE TABLE IF NOT EXISTS public.telecom_number_purchase_velocity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchase_velocity_org_window ON public.telecom_number_purchase_velocity_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_velocity_user_window ON public.telecom_number_purchase_velocity_events (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.check_and_consume_number_purchase_velocity(
    p_org_id UUID,
    p_user_id UUID,
    p_max_org_burst INT DEFAULT 3,
    p_org_window_seconds INT DEFAULT 600,
    p_max_user_hourly INT DEFAULT 5,
    p_user_window_seconds INT DEFAULT 3600
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ ... $$;
```

---

### Q. SECURITY TEST RESULTS

**Suite:** `scripts/test-phase24d-sec7f-security-hardening.ts`  
**Execution Command:** `npx tsx scripts/test-phase24d-sec7f-security-hardening.ts`  
**Pass Rate:** **30 / 30 PASSED (100%)**

```
================================================================================
PHASE 24D.SEC-7F: SECURITY HARDENING CERTIFICATION TEST RESULTS
================================================================================

[M-01: Provider Resolver Secure Defaults]
  [TEST 01] ProviderAccountResolver defaults strictMode to true                          PASSED
  [TEST 02] Unmapped org fails closed with PROVIDER_ASSIGNMENT_REQUIRED                 PASSED
  [TEST 03] Customer runtime attempting non-strict resolution is strictly rejected       PASSED
  [TEST 04] Resolver emits durable security event on unmapped access attempt            PASSED

[M-02: Purchase Saga Atomic Dispatch Transition]
  [TEST 05] Atomic transition_purchase_op_to_dispatched transitions state in single op  PASSED
  [TEST 06] Competing concurrent runners cannot double-dispatch operation               PASSED
  [TEST 07] Invalid expected status rejects transition without dispatch                 PASSED

[L-01: Sensitive Credential Sanitization & Durable Events]
  [TEST 08] Security event details sanitize Twilio auth tokens and secrets              PASSED
  [TEST 09] Security events durably persisted to public.telecom_security_events         PASSED
  [TEST 10] getDurableSecurityEvents retrieves events for organization                  PASSED
  [TEST 11] Security event persistence does not throw on DB errors                      PASSED

[L-02: Pre-Purchase Availability Recheck Error Handling]
  [TEST 12] recheckNumberAvailability fails closed on 500 error                         PASSED
  [TEST 13] recheckNumberAvailability fails closed on network timeout                   PASSED
  [TEST 14] recheckNumberAvailability fails closed on malformed response                PASSED
  [TEST 15] recheckNumberAvailability redacts API credentials in error messages         PASSED

[L-03: Billable Resource Failure Isolation]
  [TEST 16] Billable resource insert failure flags billing_reconciliation_required      PASSED
  [TEST 17] Billable resource failure does NOT release acquired carrier number          PASSED
  [TEST 18] Billable resource failure emits high-severity security event                PASSED

[L-04: Distributed Session Nonce Anti-Replay]
  [TEST 19] Distributed session nonce consumes successfully on first use                PASSED
  [TEST 20] Exact same session nonce rejected on second attempt                         PASSED
  [TEST 21] Nonce replay across separate connection pools is rejected                   PASSED
  [TEST 22] validateStageBPrivilegedAuthorizationAsync validates & consumes nonce       PASSED

[SEC-7B: Number Purchase Velocity Defense]
  [TEST 23] Purchase velocity limiter allows purchases within quota                     PASSED
  [TEST 24] Purchase velocity limiter enforces organization burst limit (429)           PASSED
  [TEST 25] Purchase velocity limiter enforces user hourly limit (429)                  PASSED
  [TEST 26] In-flight concurrency blocks overlapping purchases for same org             PASSED
  [TEST 27] Purchase velocity limiter fails closed on DB error (503)                    PASSED
  [TEST 28] Purchase velocity limiter respects tenant isolation                         PASSED
  [TEST 29] /api/number-marketplace/purchase route enforces velocity check before cart  PASSED
  [TEST 30] 429 response includes proper Retry-After header                             PASSED

Total Passed: 30 / 30 (100%)
Live Twilio Mutations: 0
Real Money Movement: $0.00
```

---

### R. LEGACY REGRESSION RESULTS

| Suite | Description | Tests Passed | Status |
|---|---|---|---|
| Phase 23D.2 | Subaccount Ownership & Parent Bypass Verification | 21 / 21 | ✅ PASS |
| Phase 23D.3 | Durable Number Purchase Saga Certification | 35 / 35 | ✅ PASS |
| Phase 23D.6 | Durable Number Release Saga Certification | 70 / 70 | ✅ PASS |
| Phase 23D.9B | Canonical Billing, Slots, and Ledger Certification | 80 / 80 | ✅ PASS |
| Phase 24D.SEC-7B.1 | Number Marketplace Search Abuse Defense | 16 / 16 | ✅ PASS |
| Phase 24D.SEC-1 | Multi-Tenant IDOR / BOLA Authorization Matrix | 28 / 28 | ✅ PASS |
| Phase 24D.SEC-5 | Authentication & Abuse Defense Core | 34 / 34 | ✅ PASS |
| Phase 24D.SEC-7F | Pre-VPS Security Hardening & Velocity Defense | 30 / 30 | ✅ PASS |
| **Total Cumulative** | **All Security & Lifecycle Suites** | **314 / 314** | **100% PASS** |

---

### S. TYPECHECK / BUILD / DIFF CHECK

- **Diff Cleanliness (`git diff --check`):** PASSED (0 whitespace or syntax formatting warnings).
- **TypeScript Compilation (`npx tsc --noEmit`):** PASSED (0 errors).
- **Next.js Production Build (`npm run build`):** PASSED (Compiled in 6.3s, 110/110 static & dynamic routes generated with Turbopack).

---

### T. DEPLOYMENT / COMMIT SHA

- **Commit SHA:** `132c24662a63d80503ba818efbf59cb402606371`
- **Commit Message:** `fix(sec-7f): pre-vps security hardening (M-01, M-02, L-01-L-04) and purchase velocity defense`
- **Target Branch:** `main` (`origin/main`)
- **Remote:** `https://github.com/ujjwalror/krispcall_voip_clone.git`
- **Files Committed:** 213 files changed, 44,669 insertions(+), 1,447 deletions(-)

---

### U. LIVE PROVIDER MUTATION COUNT

```
================================================================================
CARRIER / FINANCIAL MUTATION TRIPWIRE AUDIT
================================================================================
Twilio Child Accounts Created:      0
Twilio API Keys Created:            0
Phone Numbers Purchased:            0
Phone Numbers Released:             0
Caller-ID Verification Calls:       0
Voice Calls (Inbound/Outbound):     0
SMS Messages Sent/Received:         0
MMS Messages Sent/Received:         0
Porting Operations Dispatched:      0
Stripe Charges Incurred:            $0.00
Telecom Wallet Funds Added:         $0.00
================================================================================
TOTAL MUTATIONS:                    0 (STRICT ZERO MUTATION COMPLIANCE)
================================================================================
```

---

### V. REMAINING PRE-VPS WORK

Zero blocking pre-VPS security vulnerabilities remain. All M-level and L-level findings identified in SEC-7C audit are resolved. Minor low-priority rate-limiting items on non-billable endpoints (audio preview, portability lookup) remain cataloged in Section O as low-risk items suitable for normal operational maintenance.

---

### W. ITEMS DEFERRED SPECIFICALLY TO VPS/KMS

In accordance with Phase 23F.3B-DEFER and Phase 24D.SEC-7E, the following operations are strictly held for the VPS / Cloud KMS activation phase:
1. **AWS KMS / Cloud HSM Activation:** Configuring `TELECOM_KMS_PROVIDER = 'AWS_KMS'` and master Key Encryption Key (`TELECOM_KMS_KEY_ID`).
2. **Envelope Vault Secret Storage:** Calling `vault.storeSecret()` in production mode (`telecom_vault_secrets`).
3. **Twilio Child Subaccount Creation:** Provisioning the Stage-B customer subaccount and capturing the one-time runtime API key directly into the KMS envelope vault.
4. **Funding & Purchase of Number A:** Funding the Stage-B disposable organization wallet and executing the purchase of test number A.

---

### X. EXACT NEXT STEP

```
================================================================================
OPERATOR DIRECTIVE: FINAL STOP
================================================================================
1. DO NOT MIGRATE TO VPS.
2. DO NOT ACTIVATE AWS KMS.
3. DO NOT CREATE TWILIO CHILD SUBACCOUNT.
4. DO NOT FUND STAGE-B WALLET.
5. DO NOT PURCHASE PHONE NUMBERS.
6. DO NOT ENABLE PROVIDER MUTATION GATES.
================================================================================
```

Awaiting operator instruction to proceed to the dedicated VPS / KMS infrastructure provisioning phase.
