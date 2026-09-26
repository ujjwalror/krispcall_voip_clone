-- Phase 7.4 Migration: User Phone Assignments RLS & Performance Indexes
-- Date: 2026-10-05

-- 1. Ensure table user_phone_assignments has strict multi-tenant RLS policies
ALTER TABLE public.user_phone_assignments ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if present to enforce strict role-scoped access
DROP POLICY IF EXISTS "Users can view phone assignments in their organization" ON public.user_phone_assignments;
DROP POLICY IF EXISTS "Owners and Admins can view all phone assignments in their organization" ON public.user_phone_assignments;
DROP POLICY IF EXISTS "Managers and Agents can view their own phone assignments" ON public.user_phone_assignments;
DROP POLICY IF EXISTS "Owners and Admins can insert phone assignments in their organization" ON public.user_phone_assignments;
DROP POLICY IF EXISTS "Owners and Admins can delete phone assignments in their organization" ON public.user_phone_assignments;

-- SELECT Policies:
-- Owner / Admin can view all phone assignments in their organization
CREATE POLICY "Owners and Admins can view all phone assignments in their organization"
    ON public.user_phone_assignments FOR SELECT
    TO authenticated
    USING (
        organization_id = public.get_auth_organization_id()
        AND EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND active = true
              AND role IN ('owner', 'admin')
        )
    );

-- Manager / Agent can view only their own assigned phone numbers
CREATE POLICY "Managers and Agents can view their own phone assignments"
    ON public.user_phone_assignments FOR SELECT
    TO authenticated
    USING (
        organization_id = public.get_auth_organization_id()
        AND user_id = auth.uid()
    );

-- INSERT Policy:
-- Owner / Admin can insert assignments for active members & active numbers in their organization
CREATE POLICY "Owners and Admins can insert phone assignments in their organization"
    ON public.user_phone_assignments FOR INSERT
    TO authenticated
    WITH CHECK (
        organization_id = public.get_auth_organization_id()
        AND EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND active = true
              AND role IN ('owner', 'admin')
        )
        AND EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = user_id
              AND organization_id = public.get_auth_organization_id()
              AND active = true
        )
        AND EXISTS (
            SELECT 1 FROM public.phone_numbers
            WHERE id = phone_number_id
              AND organization_id = public.get_auth_organization_id()
              AND active = true
              AND status = 'active'
        )
    );

-- DELETE Policy:
-- Owner / Admin can delete assignments in their organization
CREATE POLICY "Owners and Admins can delete phone assignments in their organization"
    ON public.user_phone_assignments FOR DELETE
    TO authenticated
    USING (
        organization_id = public.get_auth_organization_id()
        AND EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND active = true
              AND role IN ('owner', 'admin')
        )
    );

-- 2. Indexes & Performance Optimization
CREATE INDEX IF NOT EXISTS idx_user_phone_assignments_phone_id ON public.user_phone_assignments(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_user_phone_assignments_org_id ON public.user_phone_assignments(organization_id);
