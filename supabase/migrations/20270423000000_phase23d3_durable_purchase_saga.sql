-- ==============================================================================
-- PHASE 23D.3 ADDITIVE MIGRATION: DURABLE PURCHASE SAGA & RECONCILIATION
-- Date: 2027-04-23
-- Monotonically follows: 20270422000000_phase23d1_canonical_number_schema_foundation.sql
-- Purely additive. Preserves all legacy columns, existing rows, and constraints.
-- ==============================================================================

-- 1. ADDITIVE COLUMNS ON public.provider_number_operations
ALTER TABLE public.provider_number_operations
ADD COLUMN IF NOT EXISTS canonical_state TEXT NULL,
ADD COLUMN IF NOT EXISTS quote_id UUID NULL REFERENCES public.phone_number_price_quotes(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS provider_order_id TEXT NULL,
ADD COLUMN IF NOT EXISTS error_category TEXT NULL,
ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS billing_authorization_id TEXT NULL,
ADD COLUMN IF NOT EXISTS billing_authorization_state TEXT NULL;

-- 2. CHECK CONSTRAINTS ON provider_number_operations
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_provider_num_ops_canonical_state'
    ) THEN
        ALTER TABLE public.provider_number_operations
        ADD CONSTRAINT chk_provider_num_ops_canonical_state
        CHECK (canonical_state IS NULL OR canonical_state IN (
            'REQUESTED',
            'VALIDATING',
            'AUTHORIZED',
            'PROVIDER_DISPATCH_PENDING',
            'PROVIDER_DISPATCHED',
            'PROVIDER_OUTCOME_UNKNOWN',
            'CONFIRMED',
            'FAILED',
            'RECONCILIATION_REQUIRED',
            'MANUAL_REVIEW_REQUIRED'
        ));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_provider_num_ops_billing_auth_state'
    ) THEN
        ALTER TABLE public.provider_number_operations
        ADD CONSTRAINT chk_provider_num_ops_billing_auth_state
        CHECK (billing_authorization_state IS NULL OR billing_authorization_state IN (
            'PENDING',
            'AUTHORIZED',
            'FAILED',
            'EXPIRED',
            'CAPTURED',
            'RELEASED'
        ));
    END IF;
END $$;

-- 3. INDEXES FOR CANONICAL SAGA OPERATIONS
CREATE INDEX IF NOT EXISTS idx_provider_num_ops_canonical_state
ON public.provider_number_operations(canonical_state);

CREATE INDEX IF NOT EXISTS idx_provider_num_ops_quote_id
ON public.provider_number_operations(quote_id);

CREATE INDEX IF NOT EXISTS idx_provider_num_ops_provider_account_id
ON public.provider_number_operations(provider_account_id);

-- 4. ADDITIVE COLUMNS ON public.phone_number_price_quotes (CONSUMPTION TRACKING)
ALTER TABLE public.phone_number_price_quotes
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
ADD COLUMN IF NOT EXISTS consumed_by_operation_id UUID NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_price_quotes_status'
    ) THEN
        ALTER TABLE public.phone_number_price_quotes
        ADD CONSTRAINT chk_price_quotes_status
        CHECK (status IN ('active', 'consumed', 'expired', 'invalidated'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_price_quotes_status_expires
ON public.phone_number_price_quotes(status, expires_at);
