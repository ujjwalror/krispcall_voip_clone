-- Phase 19F.1: Greetings & Audio + Live Hold / Transfer Foundation Schema Migration
-- LOCAL MIGRATION FILE — CONTROLLED PRODUCTION DEPLOYMENT

-- 1. Create tenant_media_assets table for tenant-owned audio assets (Greetings, Hold, Transfer)
CREATE TABLE IF NOT EXISTS public.tenant_media_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NULL REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
    asset_purpose VARCHAR(50) NOT NULL CHECK (asset_purpose IN ('welcome', 'voicemail_greeting', 'hold', 'transfer')),
    name VARCHAR(255) NOT NULL,
    storage_path VARCHAR(512) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_by UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_media_assets_org_phone
    ON public.tenant_media_assets(organization_id, phone_number_id);

-- 2. Create number_audio_settings table for number-level Greetings & Audio configuration
CREATE TABLE IF NOT EXISTS public.number_audio_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    phone_number_id UUID NOT NULL REFERENCES public.phone_numbers(id) ON DELETE CASCADE,
    
    -- Welcome Audio Category
    welcome_mode VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (welcome_mode IN ('tts', 'custom_audio', 'none')),
    welcome_tts_message TEXT NULL,
    welcome_tts_voice VARCHAR(100) NOT NULL DEFAULT 'Polly.Joanna',
    welcome_asset_id UUID NULL REFERENCES public.tenant_media_assets(id) ON DELETE SET NULL,
    
    -- Voicemail Greeting Category
    voicemail_greeting_mode VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (voicemail_greeting_mode IN ('tts', 'custom_audio', 'none')),
    voicemail_greeting_tts_message TEXT NULL,
    voicemail_greeting_tts_voice VARCHAR(100) NOT NULL DEFAULT 'Polly.Joanna',
    voicemail_greeting_asset_id UUID NULL REFERENCES public.tenant_media_assets(id) ON DELETE SET NULL,
    
    -- Hold Audio Category
    hold_mode VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (hold_mode IN ('tts', 'custom_audio', 'none')),
    hold_tts_message TEXT NULL,
    hold_tts_voice VARCHAR(100) NOT NULL DEFAULT 'Polly.Joanna',
    hold_asset_id UUID NULL REFERENCES public.tenant_media_assets(id) ON DELETE SET NULL,
    
    -- Transfer Audio Category
    transfer_mode VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (transfer_mode IN ('tts', 'custom_audio', 'none')),
    transfer_tts_message TEXT NULL,
    transfer_tts_voice VARCHAR(100) NOT NULL DEFAULT 'Polly.Joanna',
    transfer_asset_id UUID NULL REFERENCES public.tenant_media_assets(id) ON DELETE SET NULL,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT uq_number_audio_settings_phone_number UNIQUE (phone_number_id)
);

CREATE INDEX IF NOT EXISTS idx_number_audio_settings_org_phone
    ON public.number_audio_settings(organization_id, phone_number_id);

-- Enable RLS
ALTER TABLE public.tenant_media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.number_audio_settings ENABLE ROW LEVEL SECURITY;

-- 3. Explicit RLS Policies for tenant_media_assets (with cross-tenant phone_number_id consistency)
DROP POLICY IF EXISTS tenant_media_assets_select_tenant ON public.tenant_media_assets;
CREATE POLICY tenant_media_assets_select_tenant ON public.tenant_media_assets
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

DROP POLICY IF EXISTS tenant_media_assets_insert_admin ON public.tenant_media_assets;
CREATE POLICY tenant_media_assets_insert_admin ON public.tenant_media_assets
    FOR INSERT TO authenticated
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
        AND (
            phone_number_id IS NULL
            OR phone_number_id IN (
                SELECT id FROM public.phone_numbers WHERE organization_id = tenant_media_assets.organization_id
            )
        )
    );

DROP POLICY IF EXISTS tenant_media_assets_update_admin ON public.tenant_media_assets;
CREATE POLICY tenant_media_assets_update_admin ON public.tenant_media_assets
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
        AND (
            phone_number_id IS NULL
            OR phone_number_id IN (
                SELECT id FROM public.phone_numbers WHERE organization_id = tenant_media_assets.organization_id
            )
        )
    );

DROP POLICY IF EXISTS tenant_media_assets_delete_admin ON public.tenant_media_assets;
CREATE POLICY tenant_media_assets_delete_admin ON public.tenant_media_assets
    FOR DELETE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

-- 4. Explicit RLS Policies for number_audio_settings (with strict phone_number_id org consistency)
DROP POLICY IF EXISTS number_audio_settings_select_tenant ON public.number_audio_settings;
CREATE POLICY number_audio_settings_select_tenant ON public.number_audio_settings
    FOR SELECT TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
    );

DROP POLICY IF EXISTS number_audio_settings_insert_admin ON public.number_audio_settings;
CREATE POLICY number_audio_settings_insert_admin ON public.number_audio_settings
    FOR INSERT TO authenticated
    WITH CHECK (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
        AND phone_number_id IN (
            SELECT id FROM public.phone_numbers WHERE organization_id = number_audio_settings.organization_id
        )
    );

DROP POLICY IF EXISTS number_audio_settings_update_admin ON public.number_audio_settings;
CREATE POLICY number_audio_settings_update_admin ON public.number_audio_settings
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
        AND phone_number_id IN (
            SELECT id FROM public.phone_numbers WHERE organization_id = number_audio_settings.organization_id
        )
    );

DROP POLICY IF EXISTS number_audio_settings_delete_admin ON public.number_audio_settings;
CREATE POLICY number_audio_settings_delete_admin ON public.number_audio_settings
    FOR DELETE TO authenticated
    USING (
        organization_id IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

-- 5. Idempotent Private Supabase Storage Bucket Declaration for tenant-audio-assets
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'tenant-audio-assets',
    'tenant-audio-assets',
    false,
    5242880,
    ARRAY['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg']
)
ON CONFLICT (id) DO UPDATE SET
    public = false,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg'];

-- 6. Storage Object RLS Policies for tenant-audio-assets bucket (Folder 1 = Org ID, Folder 2 = Phone Number ID)
DROP POLICY IF EXISTS tenant_audio_assets_storage_select ON storage.objects;
CREATE POLICY tenant_audio_assets_storage_select ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'tenant-audio-assets'
        AND (storage.foldername(name))[1]::uuid IN (
            SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
        AND (storage.foldername(name))[2]::uuid IN (
            SELECT id FROM public.phone_numbers
            WHERE organization_id = (storage.foldername(name))[1]::uuid
        )
    );

DROP POLICY IF EXISTS tenant_audio_assets_storage_insert ON storage.objects;
CREATE POLICY tenant_audio_assets_storage_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'tenant-audio-assets'
        AND (storage.foldername(name))[1]::uuid IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
        AND (storage.foldername(name))[2]::uuid IN (
            SELECT id FROM public.phone_numbers
            WHERE organization_id = (storage.foldername(name))[1]::uuid
        )
    );

DROP POLICY IF EXISTS tenant_audio_assets_storage_update ON storage.objects;
CREATE POLICY tenant_audio_assets_storage_update ON storage.objects
    FOR UPDATE TO authenticated
    USING (
        bucket_id = 'tenant-audio-assets'
        AND (storage.foldername(name))[1]::uuid IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
        AND (storage.foldername(name))[2]::uuid IN (
            SELECT id FROM public.phone_numbers
            WHERE organization_id = (storage.foldername(name))[1]::uuid
        )
    )
    WITH CHECK (
        bucket_id = 'tenant-audio-assets'
        AND (storage.foldername(name))[1]::uuid IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
        AND (storage.foldername(name))[2]::uuid IN (
            SELECT id FROM public.phone_numbers
            WHERE organization_id = (storage.foldername(name))[1]::uuid
        )
    );

DROP POLICY IF EXISTS tenant_audio_assets_storage_delete ON storage.objects;
CREATE POLICY tenant_audio_assets_storage_delete ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'tenant-audio-assets'
        AND (storage.foldername(name))[1]::uuid IN (
            SELECT organization_id FROM public.profiles
            WHERE id = auth.uid() AND role IN ('owner', 'admin')
        )
        AND (storage.foldername(name))[2]::uuid IN (
            SELECT id FROM public.phone_numbers
            WHERE organization_id = (storage.foldername(name))[1]::uuid
        )
    );

-- 7. Table Grants for PostgREST Exposure
GRANT ALL ON public.tenant_media_assets TO authenticated;
GRANT ALL ON public.tenant_media_assets TO service_role;

GRANT ALL ON public.number_audio_settings TO authenticated;
GRANT ALL ON public.number_audio_settings TO service_role;

-- 8. Notify PostgREST Schema Reload
NOTIFY pgrst, 'reload schema';
