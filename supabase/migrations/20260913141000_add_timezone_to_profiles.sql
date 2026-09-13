-- ====================================================================
-- MIGRATION: ADD TIMEZONE & TIME_FORMAT PREFERENCES TO PUBLIC.PROFILES
-- Date: 2026-09-13
-- Enables per-user Regional Preferences (Timezone & 12h/24h Time Format)
-- ====================================================================

-- 1. Add timezone column if missing
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

-- 2. Add time_format column if missing
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS time_format TEXT NOT NULL DEFAULT '12h';
