-- ====================================================================
-- MIGRATION: PHASE 10.2 SMS BACKEND FOUNDATION
-- Date: 2026-09-24
-- Extends public.messages and public.phone_numbers for multi-number SMS capabilities
-- ====================================================================

-- 1. Extend public.messages with error tracking & unread status
ALTER TABLE public.messages
ADD COLUMN IF NOT EXISTS error_code TEXT NULL,
ADD COLUMN IF NOT EXISTS error_message TEXT NULL,
ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Extend public.phone_numbers with explicit provider capabilities
-- Default FALSE ensures new and existing numbers require explicit capability registration
ALTER TABLE public.phone_numbers
ADD COLUMN IF NOT EXISTS capabilities_voice BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS capabilities_sms BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS capabilities_mms BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Add performance indexes for message list and thread queries
CREATE INDEX IF NOT EXISTS idx_messages_org_created ON public.messages(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_from_to ON public.messages(from_number, to_number);
