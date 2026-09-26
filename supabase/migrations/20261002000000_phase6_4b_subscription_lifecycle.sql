-- ====================================================================
-- PUBLIC SAAS PHASE 6.4B — SUBSCRIPTION LIFECYCLE NEUTRAL FIELDS
-- Date: 2026-10-02
-- Adds canceled_at and ended_at to public.organization_subscriptions
-- ====================================================================

ALTER TABLE public.organization_subscriptions
ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.organization_subscriptions.canceled_at IS
  'Timestamp recording when cancellation was requested/initiated. It does NOT determine cancellation/access policy.';

COMMENT ON COLUMN public.organization_subscriptions.ended_at IS
  'Timestamp recording when subscription access/lifecycle actually ended.';
