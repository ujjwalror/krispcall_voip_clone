-- ====================================================================
-- CREATE SAMPLE ADMIN USER FOR IMMEDIATE TESTING
-- Run this script in your Supabase Dashboard -> SQL Editor
-- ====================================================================

-- 1. Ensure Legendary Careers Organization Record Exists
INSERT INTO public.organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Legendary Careers', 'legendary-careers')
ON CONFLICT (slug) DO UPDATE SET name = 'Legendary Careers';

-- 2. Create Test Admin User in auth.users
INSERT INTO auth.users (
    id,
    instance_id,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    role,
    aud
)
VALUES (
    'a1b2c3d4-e5f6-7890-abcd-1234567890ab',
    '00000000-0000-0000-0000-000000000000',
    'admin@legendarycareers.com',
    crypt('Password123!', gen_salt('bf')),
    NOW(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Alex Smith"}',
    NOW(),
    NOW(),
    'authenticated',
    'authenticated'
)
ON CONFLICT (id) DO UPDATE SET encrypted_password = crypt('Password123!', gen_salt('bf'));

-- 3. Create Matching Profile in public.profiles
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
    'a1b2c3d4-e5f6-7890-abcd-1234567890ab',
    '00000000-0000-0000-0000-000000000001',
    'Alex Smith (Admin)',
    'admin@legendarycareers.com',
    'admin',
    TRUE,
    'agent_alex_smith'
)
ON CONFLICT (id) DO UPDATE SET role = 'admin', active = TRUE;
