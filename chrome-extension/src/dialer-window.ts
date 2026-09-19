/**
 * VoIP Hub Chrome Extension - Primary Standalone Dialer Window Controller
 * Single unified owner of Authentication, Microphone Authorization, Twilio.Device WebRTC Media, and Call UI.
 */

import { safeStorageGet, safeStorageSet, safeStorageRemove } from './storage';
import { SERVER_BASE } from './config';

declare const Twilio: any;
declare const chrome: any;

export interface CrmContext {
  provider?: string;
  recordType?: string;
  recordId?: string;
  recordName?: string;
  phoneLabel?: string;
  phoneNumber?: string;
}

let device: any = null;
let activeCall: any = null;
let callTimerInterval: any = null;
let secondsElapsed = 0;
let isMuted = false;
let authToken: string | null = null;
let isDeviceInitializing = false;
let currentCrmContext: CrmContext | null = null;

function normalizeE164(phone: string): { isValid: boolean; normalized: string; error?: string } {
  if (!phone || typeof phone !== 'string') {
    return { isValid: false, normalized: '', error: 'Destination number is required.' };
  }
  const stripped = phone.trim().replace(/[\s\-\(\)\.]/g, '');
  if (!stripped) {
    return { isValid: false, normalized: '', error: 'Destination number cannot be blank.' };
  }
  let normalized = stripped;
  if (!normalized.startsWith('+')) {
    if (/^\d{7,15}$/.test(normalized)) {
      normalized = `+${normalized}`;
    } else {
      return { isValid: false, normalized: '', error: 'Enter a valid international phone number' };
    }
  }
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
    return { isValid: false, normalized: '', error: 'Enter a valid international phone number' };
  }
  return { isValid: true, normalized };
}

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateStatusBadge(text: string, color: string, borderColor: string) {
  const badge = document.getElementById('status-badge');
  if (badge) {
    badge.textContent = text;
    badge.style.color = color;
    badge.style.borderColor = borderColor;
  }
}

function showError(msg: string | null) {
  const banner = document.getElementById('error-banner');
  if (!banner) return;
  if (!msg) {
    banner.style.display = 'none';
    banner.textContent = '';
  } else {
    banner.textContent = msg;
    banner.style.display = 'block';
  }
}

function setView(viewName: 'SIGNED_OUT' | 'MIC_SETUP' | 'READY' | 'ACTIVE_CALL') {
  const signedOut = document.getElementById('signed-out-view');
  const micSetup = document.getElementById('mic-setup-view');
  const ready = document.getElementById('ready-view');
  const activeCallView = document.getElementById('active-call-view');

  if (signedOut) signedOut.style.display = viewName === 'SIGNED_OUT' ? 'flex' : 'none';
  if (micSetup) micSetup.style.display = viewName === 'MIC_SETUP' ? 'flex' : 'none';
  if (ready) ready.style.display = viewName === 'READY' ? 'flex' : 'none';
  if (activeCallView) activeCallView.style.display = viewName === 'ACTIVE_CALL' ? 'flex' : 'none';
}

function startCallTimer() {
  stopCallTimer();
  secondsElapsed = 0;
  const timerElem = document.getElementById('active-timer');
  if (timerElem) timerElem.textContent = '00:00';

  callTimerInterval = setInterval(() => {
    secondsElapsed++;
    if (timerElem) timerElem.textContent = formatTimer(secondsElapsed);
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
}

async function getStoredAuthToken(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh) {
    const storageRes = await safeStorageGet(['voiphub_ext_token', 'voiphub_user_name']);
    if (storageRes.invalidated) {
      console.warn('[VoIP Hub Window] Extension context invalidated');
      return null;
    }
    if (storageRes.success && storageRes.value?.voiphub_ext_token && typeof storageRes.value.voiphub_ext_token === 'string' && storageRes.value.voiphub_ext_token.trim() !== '') {
      const userElem = document.getElementById('user-display');
      if (userElem && storageRes.value.voiphub_user_name) {
        userElem.textContent = storageRes.value.voiphub_user_name;
      }
      return storageRes.value.voiphub_ext_token;
    }
  }

  try {
    const res = await fetch(`${SERVER_BASE}/api/extension/session`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });

    if (res.ok) {
      const data = await res.json();
      if (data.authenticated && data.token) {
        await safeStorageSet({
          voiphub_ext_token: data.token,
          voiphub_user_name: data.user?.fullName || data.user?.email || 'Authenticated User',
        });
        const userElem = document.getElementById('user-display');
        if (userElem) {
          userElem.textContent = data.user?.fullName || data.user?.email || 'Authenticated User';
        }
        return data.token;
      }
    }
  } catch (err) {
    console.warn('[VoIP Hub Window] Session check notice:', err);
  }

  return null;
}

async function fetchBusinessNumbers() {
  const selectElem = document.getElementById('business-number-select') as HTMLSelectElement;
  if (!selectElem || !authToken) return;

  try {
    const res = await fetch(`${SERVER_BASE}/api/extension/phone-numbers`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
    });

    if (res.ok) {
      const data = await res.json();
      if (data.phoneNumbers && Array.isArray(data.phoneNumbers) && data.phoneNumbers.length > 0) {
        selectElem.innerHTML = '';
        data.phoneNumbers.forEach((num: any) => {
          const opt = document.createElement('option');
          opt.value = num.phone_number;
          opt.textContent = `${num.friendly_name || 'Business'} (${num.phone_number})`;
          if (num.is_primary) opt.selected = true;
          selectElem.appendChild(opt);
        });
      }
    }
  } catch (err) {
    console.warn('[VoIP Hub Window] Business numbers fetch warning:', err);
  }
}

async function initializeTwilioDevice(): Promise<boolean> {
  if (device || isDeviceInitializing) return Boolean(device);
  isDeviceInitializing = true;

  authToken = await getStoredAuthToken(false);
  if (!authToken) {
    showError('Authentication required. Sign in to VoIP Hub.');
    updateStatusBadge('● Signed Out', '#f87171', 'rgba(239, 68, 68, 0.3)');
    setView('SIGNED_OUT');
    isDeviceInitializing = false;
    return false;
  }

  try {
    let res = await fetch(`${SERVER_BASE}/api/extension/token`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
    });

    if (res.status === 401 || res.status === 403) {
      authToken = await getStoredAuthToken(true);
      if (!authToken) {
        showError('Session expired. Please sign in again.');
        setView('SIGNED_OUT');
        isDeviceInitializing = false;
        return false;
      }

      res = await fetch(`${SERVER_BASE}/api/extension/token`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${authToken}` },
      });
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to fetch voice token');
    }

    const data = await res.json();
    const voiceToken = data.token;

    if (typeof Twilio === 'undefined' || !Twilio.Device) {
      throw new Error('Twilio Voice SDK script not loaded.');
    }

    device = new Twilio.Device(voiceToken, {
      codecPreferences: ['opus', 'pcmu'],
      enableIceRestart: true,
    });

    device.on('registered', () => {
      console.log('[VoIP Hub Window] Twilio Device registered successfully');
      isDeviceInitializing = false;
      updateStatusBadge('● Ready', '#4ade80', 'rgba(34, 197, 94, 0.3)');
    });

    device.on('error', (twErr: any) => {
      console.error('[VoIP Hub Window] Twilio Device error:', twErr.message || twErr);
      showError(twErr.message || 'Twilio connection error.');
      isDeviceInitializing = false;
    });

    await device.register();
    return true;
  } catch (err: any) {
    console.error('[VoIP Hub Window] Initialization error:', err.message || err);
    showError(err.message || 'Failed to initialize phone device.');
    isDeviceInitializing = false;
    return false;
  }
}

async function checkOrRequestMicPermission(): Promise<boolean> {
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStream.getTracks().forEach((track) => track.stop());
    console.log('[VoIP Hub Window] Microphone access confirmed');
    return true;
  } catch (err: any) {
    console.error('[VoIP Hub Media] getUserMedia failed');
    console.error(`name: ${err?.name || 'UnknownError'}`);
    console.error(`message: ${err?.message || String(err)}`);

    const errName = err?.name || '';
    const errMessage = err?.message || '';

    if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
      showError('No microphone was detected on your computer.');
    } else if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
      if (errMessage.toLowerCase().includes('dismissed') || errMessage.toLowerCase().includes('not allowed')) {
        showError('Microphone permission is required before your first call.');
      } else {
        showError('Microphone is blocked for VoIP Hub in Chrome.');
      }
    } else {
      showError(errMessage || 'Microphone access failed.');
    }

    setView('MIC_SETUP');
    return false;
  }
}

async function abortCallSetup(callId: string) {
  if (!callId || !authToken) return;
  console.log('[VoIP Hub][CALL] setup abort requested for callId:', callId);
  try {
    await fetch(`${SERVER_BASE}/api/extension/calls/abort`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ callId }),
    });
    console.log('[VoIP Hub][CALL] setup abort completed for callId:', callId);
  } catch (err) {
    console.warn('[VoIP Hub Window] Abort call network warning:', err);
  }
}

async function executeOutboundCall(destinationPhone: string) {
  showError(null);

  const normResult = normalizeE164(destinationPhone);
  if (!normResult.isValid || !normResult.normalized) {
    showError(normResult.error || 'Enter a valid international phone number');
    return;
  }
  const destination = normResult.normalized;

  const hasMic = await checkOrRequestMicPermission();
  if (!hasMic) return;

  if (!device) {
    const initOk = await initializeTwilioDevice();
    if (!initOk) return;
  }

  const fromSelect = document.getElementById('business-number-select') as HTMLSelectElement;
  const recToggle = document.getElementById('record-toggle') as HTMLInputElement;
  const fromNumber = fromSelect?.value || '';
  const recordCall = recToggle ? recToggle.checked : true;

  // Update UI to Active Call View
  setView('ACTIVE_CALL');
  updateStatusBadge('● CONNECTING', '#38bdf8', 'rgba(56, 189, 248, 0.3)');

  const nameElem = document.getElementById('active-contact-name');
  const phoneElem = document.getElementById('active-target-phone');
  const fromElem = document.getElementById('active-from-number');
  const stateTitle = document.getElementById('active-state-title');
  const recBadge = document.getElementById('active-rec-badge');

  if (nameElem) nameElem.textContent = currentCrmContext?.recordName || 'Outbound Call';
  if (phoneElem) phoneElem.textContent = destination;
  if (fromElem) fromElem.textContent = `Calling from ${fromNumber || 'Primary Line'}`;
  if (stateTitle) stateTitle.textContent = 'CONNECTING';
  if (recBadge) recBadge.style.display = recordCall ? 'inline-flex' : 'none';

  let createdCallId: string | null = null;
  let isCallConnectedOrRinging = false;

  try {
    let res = await fetch(`${SERVER_BASE}/api/extension/calls/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        destination,
        fromNumber,
        recordCall,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      authToken = await getStoredAuthToken(true);
      if (authToken) {
        res = await fetch(`${SERVER_BASE}/api/extension/calls/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            destination,
            fromNumber,
            recordCall,
          }),
        });
      }
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to reserve outbound call.');
    }

    const resData = await res.json();
    createdCallId = resData.callId;

    console.log('[VoIP Hub][CALL] setup created. callId:', createdCallId);

    const params = {
      To: destination,
      dbCallId: createdCallId,
      recordCall: recordCall ? 'true' : 'false',
    };

    console.log('[VoIP Hub][CALL] device connect starting for callId:', createdCallId);
    activeCall = await device.connect({ params });
    isMuted = false;

    activeCall.on('ringing', () => {
      console.log('[VoIP Hub][CALL] Call ringing');
      isCallConnectedOrRinging = true;
      if (stateTitle) stateTitle.textContent = 'RINGING';
      updateStatusBadge('● RINGING', '#38bdf8', 'rgba(56, 189, 248, 0.3)');
    });

    activeCall.on('accept', () => {
      console.log('[VoIP Hub][CALL] device connected');
      isCallConnectedOrRinging = true;
      if (stateTitle) stateTitle.textContent = 'CONNECTED';
      updateStatusBadge('● CONNECTED', '#38bdf8', 'rgba(56, 189, 248, 0.3)');
      startCallTimer();
    });

    const handleCallEnd = () => {
      console.log('[VoIP Hub Window] Call ended');
      stopCallTimer();
      activeCall = null;
      isMuted = false;
      if (stateTitle) stateTitle.textContent = 'ENDED';
      updateStatusBadge('● ENDED', '#94a3b8', 'rgba(148, 163, 184, 0.3)');
      setTimeout(() => {
        setView('READY');
        updateStatusBadge('● Ready', '#4ade80', 'rgba(34, 197, 94, 0.3)');
      }, 2000);
    };

    activeCall.on('disconnect', handleCallEnd);
    activeCall.on('cancel', handleCallEnd);
    activeCall.on('reject', handleCallEnd);

    activeCall.on('error', (callErr: any) => {
      console.error('[VoIP Hub Window] Call error:', callErr.message || callErr);
      if (!isCallConnectedOrRinging && createdCallId) {
        abortCallSetup(createdCallId);
      }
      stopCallTimer();
      activeCall = null;
      showError(callErr.message || 'Call error encountered.');
      setView('READY');
      updateStatusBadge('● Error', '#f87171', 'rgba(239, 68, 68, 0.3)');
    });
  } catch (err: any) {
    console.error('[VoIP Hub Window] Setup error:', err.message || err);
    if (!isCallConnectedOrRinging && createdCallId) {
      await abortCallSetup(createdCallId);
    }
    stopCallTimer();
    activeCall = null;
    showError(err.message || 'Failed to place call.');
    setView('READY');
    updateStatusBadge('● Error', '#f87171', 'rgba(239, 68, 68, 0.3)');
  }
}

function applyCrmContext(ctx: CrmContext) {
  if (!ctx) return;
  currentCrmContext = ctx;
  const card = document.getElementById('crm-context-card');
  const badge = document.getElementById('crm-provider-badge');
  const name = document.getElementById('crm-contact-name');
  const label = document.getElementById('crm-phone-label');
  const destInput = document.getElementById('destination-input') as HTMLInputElement;

  if (card && ctx.phoneNumber) {
    card.style.display = 'block';
    if (badge) badge.textContent = ctx.provider === 'zoho' ? 'Zoho CRM' : (ctx.provider || 'CRM Contact');
    if (name) name.textContent = ctx.recordName || 'CRM Record';
    if (label) label.textContent = `${ctx.phoneLabel || 'Phone'}: ${ctx.phoneNumber}`;
    if (destInput) destInput.value = ctx.phoneNumber;
  }
}

// Register push listener early
chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg?.type === 'LOAD_CRM_CONTEXT' && msg.data) {
    console.log('[VoIP Hub][CRM] context received via push:', msg.data);
    applyCrmContext(msg.data);
  }
  return false;
});

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize Auth & Device
  authToken = await getStoredAuthToken(false);

  if (!authToken) {
    updateStatusBadge('● Signed Out', '#f87171', 'rgba(239, 68, 68, 0.3)');
    setView('SIGNED_OUT');
  } else {
    updateStatusBadge('● Ready', '#4ade80', 'rgba(34, 197, 94, 0.3)');
    setView('READY');
    await fetchBusinessNumbers();
    await initializeTwilioDevice();
  }

  // Pull any pending CRM Context from background service worker
  try {
    chrome.runtime.sendMessage({ type: 'GET_PENDING_CRM_CONTEXT' }, (res: any) => {
      if (chrome.runtime.lastError) return;
      if (res?.success && res.crmContext) {
        console.log('[VoIP Hub][CRM] context received via pull:', res.crmContext);
        applyCrmContext(res.crmContext);
      }
    });
  } catch (err) {
    console.warn('[VoIP Hub Window] GET_PENDING_CRM_CONTEXT warning:', err);
  }

  // Auth Form Submit
  const authForm = document.getElementById('auth-form');
  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError(null);
      const emailInput = document.getElementById('auth-email') as HTMLInputElement;
      const passInput = document.getElementById('auth-password') as HTMLInputElement;

      try {
        const res = await fetch(`${SERVER_BASE}/api/extension/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: emailInput.value, password: passInput.value }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.token) {
            await safeStorageSet({
              voiphub_ext_token: data.token,
              voiphub_user_name: data.user?.fullName || data.user?.email || 'Authenticated User',
            });
            authToken = data.token;
            setView('READY');
            updateStatusBadge('● Ready', '#4ade80', 'rgba(34, 197, 94, 0.3)');
            await fetchBusinessNumbers();
            await initializeTwilioDevice();

            // Retry pulling pending CRM context after sign-in
            chrome.runtime.sendMessage({ type: 'GET_PENDING_CRM_CONTEXT' }, (ctxRes: any) => {
              if (chrome.runtime.lastError) return;
              if (ctxRes?.success && ctxRes.crmContext) {
                console.log('[VoIP Hub][CRM] context received via pull post-signin:', ctxRes.crmContext);
                applyCrmContext(ctxRes.crmContext);
              }
            });
            return;
          }
        }

        const errData = await res.json().catch(() => ({}));
        if (res.status === 400) {
          showError(errData.error || 'Please enter a valid email and password.');
        } else if (res.status === 401) {
          showError(errData.error || 'Invalid email or password.');
        } else if (res.status === 403) {
          showError(errData.error || 'Your account is inactive. Contact your administrator.');
        } else {
          showError(errData.error || 'Authentication failed. Please try again.');
        }
      } catch (err: any) {
        console.error('[VoIP Hub Window] Sign-in network error:', err);
        showError('Unable to reach VoIP Hub backend. Please check connection and retry.');
      }
    });
  }

  // Web Login Link
  const webLogin = document.getElementById('link-web-login');
  if (webLogin) {
    webLogin.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: `${SERVER_BASE}/login` });
    });
  }

  // Enable Microphone Button
  const enableMicBtn = document.getElementById('btn-enable-mic');
  if (enableMicBtn) {
    enableMicBtn.addEventListener('click', async () => {
      showError(null);
      const ok = await checkOrRequestMicPermission();
      if (ok) {
        setView('READY');
      }
    });
  }

  // Start Call Button
  const startCallBtn = document.getElementById('btn-start-call');
  if (startCallBtn) {
    startCallBtn.addEventListener('click', async () => {
      const destInput = document.getElementById('destination-input') as HTMLInputElement;
      const destination = destInput?.value?.trim();
      if (!destination) {
        showError('Please enter a destination phone number.');
        return;
      }
      await executeOutboundCall(destination);
    });
  }

  // Mute Button
  const muteBtn = document.getElementById('btn-mute');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      if (activeCall) {
        isMuted = !isMuted;
        activeCall.mute(isMuted);
        if (isMuted) {
          muteBtn.classList.add('active');
        } else {
          muteBtn.classList.remove('active');
        }
      }
    });
  }

  // End Call Button
  const endBtn = document.getElementById('btn-end-call');
  if (endBtn) {
    endBtn.addEventListener('click', () => {
      if (activeCall) {
        activeCall.disconnect();
      } else if (device) {
        device.disconnectAll();
      }
    });
  }

  // In-Call Keypad Toggle
  const keypadToggle = document.getElementById('btn-keypad-toggle');
  const keypadGrid = document.getElementById('incall-keypad-grid');
  if (keypadToggle && keypadGrid) {
    keypadToggle.addEventListener('click', () => {
      const isVisible = keypadGrid.style.display === 'grid';
      keypadGrid.style.display = isVisible ? 'none' : 'grid';
    });
  }

  // Keypad Button Digits
  const keyBtns = document.querySelectorAll<HTMLButtonElement>('.key-btn');
  keyBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const digit = btn.getAttribute('data-digit');
      if (!digit) return;

      if (activeCall) {
        activeCall.sendDigits(digit);
      } else {
        const destInput = document.getElementById('destination-input') as HTMLInputElement;
        if (destInput) destInput.value += digit;
      }
    });
  });
});

// Window Unload Safety: Disconnect active call if user closes dialer window during call
window.addEventListener('beforeunload', () => {
  if (activeCall) {
    console.log('[VoIP Hub Window] Window closing during active call -> disconnecting call');
    try {
      activeCall.disconnect();
    } catch {}
  }
});

export {};
