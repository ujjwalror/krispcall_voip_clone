-- ====================================================================
-- MIGRATION: ADD TIMEZONE & TIME_FORMAT PREFERENCES TO PUBLIC.PROFILES
-- Enables per-user Regional Preferences (Automatic / IANA Timezone & 12h/24h Time Format)
-- ====================================================================

-- 1. Add timezone column (NULL = Automatic / Device Timezone, String = User Override)
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT NULL;

-- 2. Add time_format column ('12h' or '24h')
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS time_format TEXT NOT NULL DEFAULT '12h';

-- 3. Add safety CHECK constraint for time_format if not already present
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM pg_constraint 
        WHERE conname = 'profiles_time_format_check'
    ) THEN
        ALTER TABLE public.profiles 
        ADD CONSTRAINT profiles_time_format_check 
        CHECK (time_format IN ('12h', '24h'));
    END IF;
END $$;

-- 4. Add column documentation comments
COMMENT ON COLUMN public.profiles.timezone IS 'User IANA time-zone override (e.g. Australia/Melbourne). NULL = Automatic device time zone.';
COMMENT ON COLUMN public.profiles.time_format IS 'Display format for user times: 12h or 24h.';
