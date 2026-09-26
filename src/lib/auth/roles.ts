import { Profile } from '@/lib/types';

/**
 * Checks if a profile belongs to an active Owner.
 */
export function isOwner(profile: Profile | null | undefined): boolean {
  if (!profile) return false;
  return profile.role === 'owner' && profile.active === true;
}

/**
 * Checks if a profile belongs to an active Owner or Administrator.
 */
export function isAdmin(profile: Profile | null | undefined): boolean {
  if (!profile) return false;
  return ['owner', 'admin'].includes(profile.role) && profile.active === true;
}

/**
 * Checks if a profile belongs to an active Agent, Manager, Admin, or Owner.
 */
export function isAgent(profile: Profile | null | undefined): boolean {
  if (!profile) return false;
  return ['owner', 'admin', 'manager', 'agent'].includes(profile.role) && profile.active === true;
}

/**
 * Checks if a profile is active.
 */
export function isActive(profile: Profile | null | undefined): boolean {
  if (!profile) return false;
  return profile.active === true;
}
