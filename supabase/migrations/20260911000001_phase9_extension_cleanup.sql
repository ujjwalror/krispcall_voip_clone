-- ====================================================================
-- PHASE 9.1 MIGRATION: EXTENSION UNIQUENESS CLEANUP & UNIQUE CONSTRAINT
-- ====================================================================

-- 1. Deduplicate existing extensions per organization (Earliest created profile keeps extension)
DO $$
DECLARE
    org_rec RECORD;
    profile_rec RECORD;
    assigned_exts TEXT[];
    max_num INT;
    new_ext_val INT;
BEGIN
    FOR org_rec IN SELECT DISTINCT organization_id FROM public.profiles WHERE organization_id IS NOT NULL LOOP
        assigned_exts := ARRAY[]::TEXT[];
        
        -- Loop through profiles in order of created_at ASC
        FOR profile_rec IN 
            SELECT id, extension 
            FROM public.profiles 
            WHERE organization_id = org_rec.organization_id 
            ORDER BY created_at ASC, id ASC
        LOOP
            IF profile_rec.extension IS NOT NULL 
               AND profile_rec.extension != '' 
               AND NOT (profile_rec.extension = ANY(assigned_exts)) THEN
                -- Extension is valid and not a duplicate, keep it
                assigned_exts := array_append(assigned_exts, profile_rec.extension);
            ELSE
                -- Calculate next available numeric extension >= 101
                max_num := 100;
                IF array_length(assigned_exts, 1) > 0 THEN
                    SELECT COALESCE(MAX(ext_num), 100) INTO max_num
                    FROM (
                        SELECT ext_num 
                        FROM unnest(assigned_exts) AS e,
                             LATERAL (SELECT CAST(e AS INTEGER) AS ext_num WHERE e ~ '^[0-9]+$') AS num
                    ) sub;
                END IF;

                new_ext_val := max_num + 1;
                WHILE new_ext_val::text = ANY(assigned_exts) LOOP
                    new_ext_val := new_ext_val + 1;
                END LOOP;

                UPDATE public.profiles 
                SET extension = new_ext_val::text, updated_at = NOW() 
                WHERE id = profile_rec.id;

                assigned_exts := array_append(assigned_exts, new_ext_val::text);
            END IF;
        END LOOP;
    END LOOP;
END $$;

-- 2. Add Unique Partial Index enforcing unique (organization_id, extension)
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_organization_extension 
ON public.profiles(organization_id, extension) 
WHERE extension IS NOT NULL AND extension != '';
