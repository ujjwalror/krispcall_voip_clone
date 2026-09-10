-- ====================================================================
-- PHASE 6 MIGRATION: CALLS UPDATE POLICY & INDEXES
-- ====================================================================

-- 1. Ensure RLS Policy for Calls Update exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'calls' AND policyname = 'Users can update call logs in their organization'
    ) THEN
        CREATE POLICY "Users can update call logs in their organization"
            ON public.calls FOR UPDATE
            TO authenticated
            USING (organization_id = public.get_auth_organization_id());
    END IF;
END $$;

-- 2. Additional Indexes for Calls Query Performance
CREATE INDEX IF NOT EXISTS idx_calls_user_created ON public.calls(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_status ON public.calls(status);
