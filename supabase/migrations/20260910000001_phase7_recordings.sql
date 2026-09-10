-- ====================================================================
-- PHASE 7 MIGRATION: WORKSPACE RECORDING PREFERENCES & RLS POLICIES
-- ====================================================================

-- 1. Add auto_recording_enabled column to public.organizations if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'auto_recording_enabled'
    ) THEN
        ALTER TABLE public.organizations ADD COLUMN auto_recording_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;
END $$;

-- 2. Add record_call column to public.calls if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'calls' AND column_name = 'record_call'
    ) THEN
        ALTER TABLE public.calls ADD COLUMN record_call BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- 3. RLS Policies for public.recordings
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'recordings' AND policyname = 'Users can insert recordings into their organization'
    ) THEN
        CREATE POLICY "Users can insert recordings into their organization"
            ON public.recordings FOR INSERT
            TO authenticated
            WITH CHECK (organization_id = public.get_auth_organization_id());
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'recordings' AND policyname = 'Users can update recordings in their organization'
    ) THEN
        CREATE POLICY "Users can update recordings in their organization"
            ON public.recordings FOR UPDATE
            TO authenticated
            USING (organization_id = public.get_auth_organization_id());
    END IF;
END $$;
