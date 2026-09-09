-- ====================================================================
-- BOOTSTRAP SQL HELPER: CREATE INITIAL ADMIN USER
-- Organization: Legendary Careers (slug: legendary-careers)
-- ====================================================================
-- Follow these steps in your Supabase SQL Editor:

-- STEP 1: Insert Legendary Careers Organization (If not already created)
INSERT INTO public.organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Legendary Careers', 'legendary-careers')
ON CONFLICT (slug) DO UPDATE SET name = 'Legendary Careers'
RETURNING id, name, slug;

-- STEP 2: Instructions to create the First Auth User in Supabase Dashboard
-- 1. Go to Supabase Dashboard -> Authentication -> Users.
-- 2. Click "Add User" -> "Create User".
-- 3. Enter your Admin Email (e.g. admin@legendarycareers.com) and Password.
-- 4. Copy the generated User UUID (e.g., 'a1b2c3d4-e5f6-7890-abcd-1234567890ab').

-- STEP 3: Insert matching Profile in public.profiles using your Auth User UUID
-- Replace 'YOUR_AUTH_USER_UUID_HERE' and 'YOUR_ADMIN_EMAIL_HERE' below:

/*
INSERT INTO public.profiles (
    id,
    organization_id,
    full_name,
    email,
    role,
    active,
    twilio_identity
)
VALUES (
    'YOUR_AUTH_USER_UUID_HERE',
    '00000000-0000-0000-0000-000000000001',
    'Initial Administrator',
    'YOUR_ADMIN_EMAIL_HERE',
    'admin',
    TRUE,
    'agent_admin'
)
ON CONFLICT (id) DO UPDATE SET
    role = 'admin',
    active = TRUE;
*/
