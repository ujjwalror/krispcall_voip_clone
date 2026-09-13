-- ====================================================================
-- MIGRATION: ADD IS_PRIMARY COLUMN TO PUBLIC.PHONE_NUMBERS
-- Date: 2026-09-13
-- Enables multi-number ready architecture with explicit primary designation
-- ====================================================================

-- 1. Add is_primary column if it does not exist
ALTER TABLE public.phone_numbers ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Mark existing business number +61348328472 as primary
UPDATE public.phone_numbers 
SET is_primary = TRUE 
WHERE phone_number = '+61348328472';
