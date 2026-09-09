import { Profile } from '@/lib/types';

/**
 * Checks if a profile belongs to an active Administrator.
 */
export function isAdmin(profile: Profile | null | undefined): boolean {
  if (!profile) return false;
  return profile.role === 'admin' && profile.active === true;
}

/**
 * Checks if a profile belongs to an active Agent or Administrator.
 */
export function isAgent(profile: Profile | null | undefined): boolean {
  if (!profile) return false;
  return (profile.role === 'agent' || profile.role === 'admin') && profile.active === true;
}

/**
 * Checks if a profile is active.
 */
export function isActive(profile: Profile | null | undefined): boolean {
  if (!profile) return false;
  return profile.active === true;
}
