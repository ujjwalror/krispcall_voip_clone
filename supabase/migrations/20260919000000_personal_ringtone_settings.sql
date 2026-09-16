-- Phase 9 Personal Ringtone Preferences Migration
-- Date: 2026-09-19
-- Adds ringtone_volume and ringtone_name columns to public.profiles table
-- to allow per-user persistence of incoming call ringtone audio preferences.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'ringtone_volume'
    ) THEN
        ALTER TABLE public.profiles ADD COLUMN ringtone_volume INT NOT NULL DEFAULT 80;
        ALTER TABLE public.profiles ADD CONSTRAINT check_ringtone_volume_range CHECK (ringtone_volume >= 0 AND ringtone_volume <= 100);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'ringtone_name'
    ) THEN
        ALTER TABLE public.profiles ADD COLUMN ringtone_name TEXT NOT NULL DEFAULT 'classic';
        ALTER TABLE public.profiles ADD CONSTRAINT check_ringtone_name_valid CHECK (ringtone_name IN ('classic', 'soft', 'digital', 'pulse', 'minimal'));
    END IF;
END $$;
