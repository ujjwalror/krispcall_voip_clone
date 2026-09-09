-- ====================================================================
-- INITIAL DEVELOPMENT SEED DATA (OPTIONAL FOR DEVELOPMENT)
-- Date: 2026-09-09
-- Insert initial organization record
-- ====================================================================

-- Insert Default Internal Organization
INSERT INTO public.organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Internal Telecom Org', 'internal-telecom')
ON CONFLICT (slug) DO NOTHING;

-- Insert Primary Twilio Phone Number Record
INSERT INTO public.phone_numbers (id, organization_id, phone_number, friendly_name, active)
VALUES (
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000001',
    '+18005550199',
    'Main Business Line',
    TRUE
)
ON CONFLICT (phone_number) DO NOTHING;
