-- Phase 17G.4 Controlled Production Semantic Correction
-- Reconciles legacy development stubs (Records 2, 3, 5, 7) and ported number (Record 6) to explicit, semantically correct lifecycle states.

-- 1. Ensure phone_numbers status constraint permits legacy_quarantined
ALTER TABLE public.phone_numbers 
  DROP CONSTRAINT IF EXISTS chk_phone_numbers_status;

ALTER TABLE public.phone_numbers 
  ADD CONSTRAINT chk_phone_numbers_status 
  CHECK (status IN (
    'active', 
    'inactive', 
    'suspended', 
    'released', 
    'ported_out', 
    'legacy_quarantined'
  ));

-- 2. Ensure phone_number_lifecycle_states lifecycle_state constraint permits ported_out AND legacy_quarantined
ALTER TABLE public.phone_number_lifecycle_states 
  DROP CONSTRAINT IF EXISTS phone_number_lifecycle_states_lifecycle_state_check;

ALTER TABLE public.phone_number_lifecycle_states 
  ADD CONSTRAINT phone_number_lifecycle_states_lifecycle_state_check 
  CHECK (lifecycle_state IN (
    'active', 
    'past_due', 
    'suspended', 
    'release_pending', 
    'released', 
    'ported_out', 
    'legacy_quarantined'
  ));

-- 3. Update Records 2, 3, 5, 7 to legacy_quarantined
UPDATE public.phone_numbers
SET status = 'legacy_quarantined',
    active = false,
    updated_at = NOW()
WHERE id IN (
  'f3c94a9d-fe66-402a-a023-550c0c1bcfb0', -- Record 2
  '38e50215-2b40-48f5-b365-142f92f1d4fe', -- Record 3
  'cec8ed6c-d0ad-4039-b529-286b58e6a5e3', -- Record 5
  '6eed699c-b1b1-4346-96e7-508f66359955'  -- Record 7
);

UPDATE public.phone_number_lifecycle_states
SET lifecycle_state = 'legacy_quarantined',
    allow_telecom_usage = false,
    quarantine_reason = 'legacy_development_data',
    updated_at = NOW()
WHERE phone_number_id IN (
  'f3c94a9d-fe66-402a-a023-550c0c1bcfb0', -- Record 2
  '38e50215-2b40-48f5-b365-142f92f1d4fe', -- Record 3
  'cec8ed6c-d0ad-4039-b529-286b58e6a5e3', -- Record 5
  '6eed699c-b1b1-4346-96e7-508f66359955'  -- Record 7
);

-- 4. Update Record 6 lifecycle_state to ported_out (phone status remains ported_out)
UPDATE public.phone_number_lifecycle_states
SET lifecycle_state = 'ported_out',
    allow_telecom_usage = false,
    updated_at = NOW()
WHERE phone_number_id = '45e7e811-04be-4442-97a1-bf38afef1dc9'; -- Record 6
