-- ====================================================================
-- VOIP HUB — PHASE 19A MIGRATION
-- INBOUND ROUTING & IVR FOUNDATION SCHEMA
-- ====================================================================

-- 1. Extend public.phone_numbers with inbound routing configuration
ALTER TABLE public.phone_numbers
    ADD COLUMN IF NOT EXISTS inbound_routing_type TEXT NOT NULL DEFAULT 'user',
    ADD COLUMN IF NOT EXISTS inbound_routing_destination_id TEXT NULL,
    ADD COLUMN IF NOT EXISTS inbound_routing_updated_at TIMESTAMPTZ DEFAULT NOW();

-- Add check constraint for valid routing types
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_phone_numbers_routing_type'
    ) THEN
        ALTER TABLE public.phone_numbers
            ADD CONSTRAINT chk_phone_numbers_routing_type
            CHECK (inbound_routing_type IN ('user', 'ivr', 'voicemail', 'call_queue'));
    END IF;
END $$;

-- Index for inbound routing lookups
CREATE INDEX IF NOT EXISTS idx_phone_numbers_inbound_routing
    ON public.phone_numbers (organization_id, inbound_routing_type);


-- 2. Create public.ivr_menus table
CREATE TABLE IF NOT EXISTS public.ivr_menus (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    greeting_type TEXT NOT NULL DEFAULT 'tts' CHECK (greeting_type IN ('tts', 'audio_url')),
    greeting_text TEXT NOT NULL DEFAULT 'Thank you for calling. Please make a selection from the following options.',
    greeting_audio_url TEXT NULL,
    timeout_seconds INT NOT NULL DEFAULT 5 CHECK (timeout_seconds >= 1 AND timeout_seconds <= 30),
    max_retries INT NOT NULL DEFAULT 3 CHECK (max_retries >= 1 AND max_retries <= 10),
    timeout_destination_type TEXT NOT NULL DEFAULT 'user',
    timeout_destination_id TEXT NULL,
    fallback_destination_type TEXT NOT NULL DEFAULT 'user',
    fallback_destination_id TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on ivr_menus
CREATE INDEX IF NOT EXISTS idx_ivr_menus_organization
    ON public.ivr_menus (organization_id, enabled);

-- Updated_at trigger for ivr_menus
CREATE TRIGGER update_ivr_menus_updated_at
    BEFORE UPDATE ON public.ivr_menus
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- 3. Create public.ivr_options table
CREATE TABLE IF NOT EXISTS public.ivr_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    ivr_menu_id UUID NOT NULL REFERENCES public.ivr_menus(id) ON DELETE CASCADE,
    digit TEXT NOT NULL CHECK (digit IN ('0','1','2','3','4','5','6','7','8','9','*','#')),
    destination_type TEXT NOT NULL CHECK (destination_type IN ('user', 'ivr', 'voicemail', 'call_queue', 'hangup')),
    destination_id TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ivr_options_menu_digit_key UNIQUE (ivr_menu_id, digit)
);

-- Index on ivr_options
CREATE INDEX IF NOT EXISTS idx_ivr_options_menu
    ON public.ivr_options (ivr_menu_id, enabled);

-- Updated_at trigger for ivr_options
CREATE TRIGGER update_ivr_options_updated_at
    BEFORE UPDATE ON public.ivr_options
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- 4. Enable Row-Level Security (RLS) on IVR tables
ALTER TABLE public.ivr_menus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ivr_options ENABLE ROW LEVEL SECURITY;


-- 5. RLS Policies for ivr_menus
DROP POLICY IF EXISTS ivr_menus_select_tenant ON public.ivr_menus;
CREATE POLICY ivr_menus_select_tenant ON public.ivr_menus
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

DROP POLICY IF EXISTS ivr_menus_insert_admin ON public.ivr_menus;
CREATE POLICY ivr_menus_insert_admin ON public.ivr_menus
    FOR INSERT TO authenticated
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

DROP POLICY IF EXISTS ivr_menus_update_admin ON public.ivr_menus;
CREATE POLICY ivr_menus_update_admin ON public.ivr_menus
    FOR UPDATE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    )
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

DROP POLICY IF EXISTS ivr_menus_delete_admin ON public.ivr_menus;
CREATE POLICY ivr_menus_delete_admin ON public.ivr_menus
    FOR DELETE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );


-- 6. RLS Policies for ivr_options
DROP POLICY IF EXISTS ivr_options_select_tenant ON public.ivr_options;
CREATE POLICY ivr_options_select_tenant ON public.ivr_options
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

DROP POLICY IF EXISTS ivr_options_insert_admin ON public.ivr_options;
CREATE POLICY ivr_options_insert_admin ON public.ivr_options
    FOR INSERT TO authenticated
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

DROP POLICY IF EXISTS ivr_options_update_admin ON public.ivr_options;
CREATE POLICY ivr_options_update_admin ON public.ivr_options
    FOR UPDATE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    )
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

DROP POLICY IF EXISTS ivr_options_delete_admin ON public.ivr_options;
CREATE POLICY ivr_options_delete_admin ON public.ivr_options
    FOR DELETE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );


-- 7. Grant Permissions
REVOKE ALL ON TABLE public.ivr_menus FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.ivr_options FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ivr_menus TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ivr_options TO authenticated, service_role;
