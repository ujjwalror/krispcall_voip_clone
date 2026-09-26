-- ====================================================================
-- MIGRATION: PHASE 7.2 BUSINESS NUMBER DOMAIN FOUNDATION
-- Date: 2026-10-03
-- Establishes provider-neutral business number foundation, lifecycle status,
-- metadata fields, and provider mapping table without breaking existing telephony.
-- ====================================================================

-- 1. Extend public.phone_numbers with lifecycle status & provider-neutral metadata
ALTER TABLE public.phone_numbers
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
ADD COLUMN IF NOT EXISTS country_code VARCHAR(2) NULL,
ADD COLUMN IF NOT EXISTS number_type TEXT NULL,
ADD COLUMN IF NOT EXISTS acquisition_source TEXT NULL;

-- 2. Add safe domain CHECK constraints to public.phone_numbers
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_phone_numbers_status'
    ) THEN
        ALTER TABLE public.phone_numbers
        ADD CONSTRAINT chk_phone_numbers_status
        CHECK (status IN ('active', 'inactive', 'suspended', 'released', 'ported_out'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_phone_numbers_number_type'
    ) THEN
        ALTER TABLE public.phone_numbers
        ADD CONSTRAINT chk_phone_numbers_number_type
        CHECK (number_type IS NULL OR number_type IN ('local', 'mobile', 'toll_free'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_phone_numbers_acquisition_source'
    ) THEN
        ALTER TABLE public.phone_numbers
        ADD CONSTRAINT chk_phone_numbers_acquisition_source
        CHECK (acquisition_source IS NULL OR acquisition_source IN ('provider_purchase', 'port_in', 'legacy'));
    END IF;
END $$;

-- 3. Synchronize status & acquisition source for existing pre-Phase 7.2 records
-- Note: ADD COLUMN defaults existing rows to 'active'. This UPDATE statement converts
-- active=false legacy rows to 'inactive' while keeping active=true rows as 'active'.
UPDATE public.phone_numbers
SET status = CASE WHEN active THEN 'active' ELSE 'inactive' END;

UPDATE public.phone_numbers
SET acquisition_source = 'legacy'
WHERE acquisition_source IS NULL;

-- 4. Create provider-neutral mapping table
CREATE TABLE IF NOT EXISTS public.number_provider_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number_id UUID NOT NULL REFERENCES public.phone_numbers(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL DEFAULT 'twilio',
    provider_account_id TEXT NULL,
    provider_resource_id TEXT NOT NULL,
    provider_status TEXT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_provider_resource UNIQUE (provider, provider_resource_id)
);

-- Index for phone_number_id lookup
CREATE INDEX IF NOT EXISTS idx_number_provider_mappings_phone_id 
ON public.number_provider_mappings(phone_number_id);

-- Updated_at trigger for number_provider_mappings
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_number_provider_mappings_updated_at'
    ) THEN
        CREATE TRIGGER update_number_provider_mappings_updated_at
            BEFORE UPDATE ON public.number_provider_mappings
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- 5. Idempotent Backfill: Migrate existing Twilio SIDs into number_provider_mappings
INSERT INTO public.number_provider_mappings (phone_number_id, provider, provider_resource_id, provider_status)
SELECT 
    id AS phone_number_id, 
    'twilio' AS provider, 
    twilio_phone_number_sid AS provider_resource_id, 
    CASE WHEN active THEN 'active' ELSE 'inactive' END AS provider_status
FROM public.phone_numbers
WHERE twilio_phone_number_sid IS NOT NULL
ON CONFLICT (provider, provider_resource_id) DO NOTHING;

-- 6. Enforce Primary Number Partial Unique Index (At most 1 active primary number per org)
-- Safety Guard: Abort migration if duplicate active primary rows exist in current data
DO $$
BEGIN
    IF EXISTS (
        SELECT organization_id
        FROM public.phone_numbers
        WHERE is_primary = TRUE AND active = TRUE
        GROUP BY organization_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Migration aborted: Duplicate active primary phone numbers detected for one or more organizations. Please resolve duplicate primary numbers manually before applying this migration.';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_org_primary 
ON public.phone_numbers (organization_id) 
WHERE is_primary = TRUE AND active = TRUE;

-- 7. Row Level Security for public.number_provider_mappings
-- Infrastructure table: RLS enabled with default DENY ALL for authenticated users.
-- Server/service-role code accesses provider mappings directly.
ALTER TABLE public.number_provider_mappings ENABLE ROW LEVEL SECURITY;
