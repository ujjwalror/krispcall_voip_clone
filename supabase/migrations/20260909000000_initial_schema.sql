-- ====================================================================
-- INITIAL DATABASE SCHEMA MIGRATION: VOIP TELECOM PLATFORM
-- Date: 2026-09-09
-- PostgreSQL / Supabase Relational Schema with Row Level Security (RLS)
-- ====================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Helper Function: Auto-update updated_at Timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------------
-- TABLE 1: organizations
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_organizations_updated_at
    BEFORE UPDATE ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------
-- TABLE 2: profiles
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    twilio_identity TEXT UNIQUE,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------
-- TABLE 3: contacts
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    first_name TEXT,
    last_name TEXT,
    full_name TEXT NOT NULL,
    company TEXT,
    phone TEXT NOT NULL,
    email TEXT,
    notes TEXT,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ
);

CREATE TRIGGER update_contacts_updated_at
    BEFORE UPDATE ON public.contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------
-- TABLE 4: calls
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    twilio_call_sid TEXT UNIQUE,
    user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'initiated' CHECK (
        status IN ('queued', 'initiated', 'ringing', 'in-progress', 'completed', 'busy', 'failed', 'no-answer', 'canceled', 'missed')
    ),
    started_at TIMESTAMPTZ,
    answered_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    duration_seconds INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_calls_updated_at
    BEFORE UPDATE ON public.calls
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------
-- TABLE 5: recordings
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    call_id UUID REFERENCES public.calls(id) ON DELETE CASCADE,
    twilio_recording_sid TEXT UNIQUE,
    recording_url TEXT NOT NULL,
    duration_seconds INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_recordings_updated_at
    BEFORE UPDATE ON public.recordings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------
-- TABLE 6: messages
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    twilio_message_sid TEXT UNIQUE,
    user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    body TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    status TEXT NOT NULL DEFAULT 'sent',
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_messages_updated_at
    BEFORE UPDATE ON public.messages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------
-- TABLE 7: phone_numbers
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phone_numbers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    twilio_phone_number_sid TEXT UNIQUE,
    phone_number TEXT NOT NULL UNIQUE,
    friendly_name TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_phone_numbers_updated_at
    BEFORE UPDATE ON public.phone_numbers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------------------------------
-- TABLE 8: user_phone_assignments
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_phone_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    phone_number_id UUID NOT NULL REFERENCES public.phone_numbers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, phone_number_id)
);

-- ====================================================================
-- DATABASE INDEXES FOR QUERY OPTIMIZATION
-- ====================================================================
CREATE INDEX IF NOT EXISTS idx_profiles_organization_id ON public.profiles(organization_id);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);

CREATE INDEX IF NOT EXISTS idx_contacts_organization_id ON public.contacts(organization_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON public.contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON public.contacts(email);

CREATE INDEX IF NOT EXISTS idx_calls_organization_id ON public.calls(organization_id);
CREATE INDEX IF NOT EXISTS idx_calls_user_id ON public.calls(user_id);
CREATE INDEX IF NOT EXISTS idx_calls_contact_id ON public.calls(contact_id);
CREATE INDEX IF NOT EXISTS idx_calls_twilio_call_sid ON public.calls(twilio_call_sid);
CREATE INDEX IF NOT EXISTS idx_calls_created_at ON public.calls(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recordings_organization_id ON public.recordings(organization_id);
CREATE INDEX IF NOT EXISTS idx_recordings_call_id ON public.recordings(call_id);

CREATE INDEX IF NOT EXISTS idx_messages_organization_id ON public.messages(organization_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON public.messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_contact_id ON public.messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_twilio_message_sid ON public.messages(twilio_message_sid);

CREATE INDEX IF NOT EXISTS idx_phone_numbers_organization_id ON public.phone_numbers(organization_id);
CREATE INDEX IF NOT EXISTS idx_user_phone_assignments_user_id ON public.user_phone_assignments(user_id);

-- ====================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES & SECURITY ARCHITECTURE
-- ====================================================================

-- Enable RLS on all tables
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phone_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_phone_assignments ENABLE ROW LEVEL SECURITY;

-- Helper SQL Function: Extract Current Authenticated User's Organization ID
CREATE OR REPLACE FUNCTION public.get_auth_organization_id()
RETURNS UUID AS $$
DECLARE
    org_id UUID;
BEGIN
    SELECT organization_id INTO org_id
    FROM public.profiles
    WHERE id = auth.uid();

    RETURN org_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- RLS Policies: Public Anonymous Access IS DENIED Everywhere By Default.

-- 1. Organizations Policies
CREATE POLICY "Authenticated users can view their own organization"
    ON public.organizations FOR SELECT
    TO authenticated
    USING (id = public.get_auth_organization_id());

-- 2. Profiles Policies
CREATE POLICY "Users can view profiles in their organization"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (organization_id = public.get_auth_organization_id());

CREATE POLICY "Users can update their own profile"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

-- 3. Contacts Policies
CREATE POLICY "Users can view contacts in their organization"
    ON public.contacts FOR SELECT
    TO authenticated
    USING (organization_id = public.get_auth_organization_id());

CREATE POLICY "Users can insert contacts into their organization"
    ON public.contacts FOR INSERT
    TO authenticated
    WITH CHECK (organization_id = public.get_auth_organization_id());

CREATE POLICY "Users can update contacts in their organization"
    ON public.contacts FOR UPDATE
    TO authenticated
    USING (organization_id = public.get_auth_organization_id());

-- 4. Calls Policies
CREATE POLICY "Users can view call logs in their organization"
    ON public.calls FOR SELECT
    TO authenticated
    USING (organization_id = public.get_auth_organization_id());

CREATE POLICY "Users can create call logs in their organization"
    ON public.calls FOR INSERT
    TO authenticated
    WITH CHECK (organization_id = public.get_auth_organization_id());

-- 5. Recordings Policies
CREATE POLICY "Users can view recordings in their organization"
    ON public.recordings FOR SELECT
    TO authenticated
    USING (organization_id = public.get_auth_organization_id());

-- 6. Messages Policies
CREATE POLICY "Users can view messages in their organization"
    ON public.messages FOR SELECT
    TO authenticated
    USING (organization_id = public.get_auth_organization_id());

CREATE POLICY "Users can insert messages into their organization"
    ON public.messages FOR INSERT
    TO authenticated
    WITH CHECK (organization_id = public.get_auth_organization_id());

-- 7. Phone Numbers Policies
CREATE POLICY "Users can view phone numbers in their organization"
    ON public.phone_numbers FOR SELECT
    TO authenticated
    USING (organization_id = public.get_auth_organization_id());

-- 8. User Phone Assignments Policies
CREATE POLICY "Users can view phone assignments in their organization"
    ON public.user_phone_assignments FOR SELECT
    TO authenticated
    USING (organization_id = public.get_auth_organization_id());
