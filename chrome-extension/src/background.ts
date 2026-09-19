/**
 * VoIP Hub Chrome Extension - Background Service Worker & Window Coordinator (Manifest V3)
 * Manages the primary standalone VoIP Hub Dialer Window and routes CRM click-to-call events.
 */

import { safeStorageGet } from './storage';
import { SERVER_BASE } from './config';

declare const chrome: any;

let dialerWindowId: number | null = null;
let pendingCrmContext: any = null;

/**
 * Opens or focuses the primary standalone VoIP Hub Dialer Window.
 * Prevents creation of duplicate windows.
 */
async function openOrFocusDialerWindow(crmContext?: any): Promise<number> {
  if (crmContext) {
    pendingCrmContext = crmContext;
    console.log('[VoIP Hub BG] Stored pending CRM context:', pendingCrmContext);
  }

  if (dialerWindowId !== null) {
    try {
      const existingWin = await chrome.windows.get(dialerWindowId);
      if (existingWin) {
        console.log('[VoIP Hub BG] Focusing existing dialer window:', dialerWindowId);
        await chrome.windows.update(dialerWindowId, { focused: true });
        if (crmContext) {
          // If window is already open and initialized, push context immediately
          chrome.runtime.sendMessage({ type: 'LOAD_CRM_CONTEXT', data: crmContext }).catch(() => {});
        }
        return dialerWindowId;
      }
    } catch {
      dialerWindowId = null;
    }
  }

  console.log('[VoIP Hub BG] Creating primary VoIP Hub dialer window...');
  const createdWin = await chrome.windows.create({
    url: 'dialer-window.html',
    type: 'popup',
    width: 380,
    height: 640,
    focused: true,
  });

  dialerWindowId = createdWin?.id || null;
  console.log('[VoIP Hub BG] Primary dialer window created with ID:', dialerWindowId);

  return dialerWindowId || 0;
}

// Track dialer window closure to clean up stored window ID
chrome.windows.onRemoved.addListener((windowId: number) => {
  if (windowId === dialerWindowId) {
    console.log('[VoIP Hub BG] Primary dialer window closed by user');
    dialerWindowId = null;
  }
});

// Extension Toolbar Icon Click Handler
chrome.action.onClicked.addListener(() => {
  console.log('[VoIP Hub BG] Extension toolbar icon clicked -> opening/focusing dialer window');
  openOrFocusDialerWindow();
});

// Proxy business numbers fetch for extension contexts
async function fetchBusinessNumbersForExtension(): Promise<any[]> {
  try {
    const storageRes = await safeStorageGet(['voiphub_ext_token']);
    if (!storageRes.success || storageRes.invalidated || !storageRes.value?.voiphub_ext_token) return [];
    const token = storageRes.value.voiphub_ext_token;

    const res = await fetch(`${SERVER_BASE}/api/extension/phone-numbers`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      const data = await res.json();
      return data.phoneNumbers || [];
    }
  } catch (err) {
    console.warn('[VoIP Hub BG] Business numbers proxy notice:', err);
  }
  return [];
}

// Background Runtime Message Router
chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (res?: any) => void) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (message.type === 'INITIATE_CALL_FROM_CRM') {
    const rawData = message.data || {};
    const sanitizedContext = {
      provider: String(rawData.provider || 'crm'),
      recordType: String(rawData.recordType || 'Record'),
      recordId: rawData.recordId ? String(rawData.recordId) : undefined,
      recordName: String(rawData.recordName || 'CRM Record'),
      phoneLabel: String(rawData.phoneLabel || 'Phone'),
      phoneNumber: String(rawData.phoneNumber || '').trim(),
    };
    console.log('[VoIP Hub BG] INITIATE_CALL_FROM_CRM received:', sanitizedContext);
    openOrFocusDialerWindow(sanitizedContext);
    sendResponse({ success: true, windowId: dialerWindowId });
    return false;
  } else if (message.type === 'GET_PENDING_CRM_CONTEXT') {
    console.log('[VoIP Hub BG] GET_PENDING_CRM_CONTEXT query received. Returning:', pendingCrmContext);
    const ctx = pendingCrmContext;
    pendingCrmContext = null;
    sendResponse({ success: true, crmContext: ctx });
    return false;
  } else if (message.type === 'FETCH_BUSINESS_NUMBERS') {
    fetchBusinessNumbersForExtension().then((numbers) => {
      sendResponse({ success: true, phoneNumbers: numbers });
    });
    return true; // Async sendResponse required
  } else if (message.type === 'FOCUS_DIALER_WINDOW') {
    openOrFocusDialerWindow(message.data);
    sendResponse({ success: true });
    return false;
  }

  return false;
});

export {};
