/**
 * VoIP Hub Chrome Extension - Safe Storage Utilities
 * Protects against extension context invalidation and unhandled storage API failures.
 */

declare const chrome: any;

export interface StorageResult<T> {
  success: boolean;
  invalidated: boolean;
  value?: T;
  error?: string;
}

/**
 * Checks if chrome runtime and storage API are accessible.
 * Returns false if extension context has been invalidated or storage API is missing.
 */
export function isStorageAvailable(): boolean {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome?.runtime?.id) && Boolean(chrome?.storage?.local);
  } catch {
    return false;
  }
}

/**
 * Safely reads keys from chrome.storage.local.
 */
export async function safeStorageGet(keys: string[]): Promise<StorageResult<Record<string, any>>> {
  if (!isStorageAvailable()) {
    console.warn('[VoIP Hub Storage] Extension context invalidated or storage unavailable');
    return { success: false, invalidated: true, error: 'Extension context invalidated' };
  }

  try {
    return await new Promise((resolve) => {
      chrome.storage.local.get(keys, (result: any) => {
        if (chrome.runtime?.lastError) {
          const err = chrome.runtime.lastError.message || 'chrome.storage.local.get failed';
          console.error('[VoIP Hub Storage] Read error:', err);
          resolve({ success: false, invalidated: false, error: err });
        } else {
          resolve({ success: true, invalidated: false, value: result || {} });
        }
      });
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[VoIP Hub Storage] Exception reading storage:', msg);
    return { success: false, invalidated: false, error: msg };
  }
}

/**
 * Safely writes data to chrome.storage.local.
 */
export async function safeStorageSet(data: Record<string, any>): Promise<StorageResult<void>> {
  if (!isStorageAvailable()) {
    console.warn('[VoIP Hub Storage] Extension context invalidated or storage unavailable');
    return { success: false, invalidated: true, error: 'Extension context invalidated' };
  }

  try {
    return await new Promise((resolve) => {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime?.lastError) {
          const err = chrome.runtime.lastError.message || 'chrome.storage.local.set failed';
          console.error('[VoIP Hub Storage] Write error:', err);
          resolve({ success: false, invalidated: false, error: err });
        } else {
          resolve({ success: true, invalidated: false });
        }
      });
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[VoIP Hub Storage] Exception writing storage:', msg);
    return { success: false, invalidated: false, error: msg };
  }
}

/**
 * Safely removes keys from chrome.storage.local.
 */
export async function safeStorageRemove(keys: string[]): Promise<StorageResult<void>> {
  if (!isStorageAvailable()) {
    return { success: false, invalidated: true, error: 'Extension context invalidated' };
  }

  try {
    return await new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime?.lastError) {
          const err = chrome.runtime.lastError.message || 'chrome.storage.local.remove failed';
          console.error('[VoIP Hub Storage] Remove error:', err);
          resolve({ success: false, invalidated: false, error: err });
        } else {
          resolve({ success: true, invalidated: false });
        }
      });
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[VoIP Hub Storage] Exception removing storage:', msg);
    return { success: false, invalidated: false, error: msg };
  }
}
