'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchVoiceAccessToken } from '@/services/voice/client';
import { normalizeE164PhoneNumber } from '@/lib/utils';
import { useAuth } from '@/components/providers/AuthProvider';
import { ringtoneEngine } from '@/lib/audio/ringtoneEngine';

export type DeviceStatus = 'uninitialized' | 'initializing' | 'ready' | 'error';
export type CallState =
  | 'idle'
  | 'connecting'
  | 'ringing'
  | 'connected'
  | 'ended'
  | 'failed'
  | 'permission_denied';

export interface UseTwilioDeviceReturn {
  deviceStatus: DeviceStatus;
  callState: CallState;
  callDuration: number;
  isMuted: boolean;
  isHeld: boolean;
  isTransferModalOpen: boolean;
  errorMessage: string | null;
  identity: string | null;
  autoRecordingEnabled: boolean;
  recordCallPreference: boolean;
  incomingCaller: string | null;
  activeDestination: string | null;
  activeCallContactName: string | null;
  isDisplaced: boolean;
  displacedNotice: string | null;
  setRecordCallPreference: (val: boolean) => void;
  initDevice: () => Promise<boolean>;
  makeCall: (destinationNumber: string, contactName?: string) => Promise<boolean>;
  acceptIncomingCall: () => void;
  rejectIncomingCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  toggleHold: () => Promise<void>;
  setIsTransferModalOpen: (val: boolean) => void;
  clearError: () => void;
}

export function useTwilioDevice(): UseTwilioDeviceReturn {
  const { profile, isDisplaced, isSessionRegistered, displaceSession } = useAuth();
  const profileRef = useRef(profile);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>('uninitialized');
  const [callState, setCallState] = useState<CallState>('idle');
  const [callDuration, setCallDuration] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isHeld, setIsHeld] = useState<boolean>(false);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const [autoRecordingEnabled, setAutoRecordingEnabled] = useState<boolean>(true);
  const [recordCallPreference, setRecordCallPreference] = useState<boolean>(true);
  const [incomingCaller, setIncomingCaller] = useState<string | null>(null);
  const [activeDestination, setActiveDestination] = useState<string | null>(null);
  const [activeCallContactName, setActiveCallContactName] = useState<string | null>(null);

  const deviceRef = useRef<any>(null);
  const activeCallRef = useRef<any>(null);
  const incomingCallRef = useRef<any>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const initPromiseRef = useRef<Promise<boolean> | null>(null);
  const isCallSetupInProgressRef = useRef<boolean>(false);

  const displacedNotice = isDisplaced && callState === 'connected'
    ? 'This account was signed in on another device. Your session will end when this call finishes.'
    : null;

  // Timer helpers for connected call duration
  const startTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCallDuration(0);
    timerRef.current = setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resetCallStateAfterDelay = useCallback(() => {
    setTimeout(() => {
      setCallState('idle');
      setIsMuted(false);
      activeCallRef.current = null;
      incomingCallRef.current = null;
      setIncomingCaller(null);
      setActiveDestination(null);
      setActiveCallContactName(null);
    }, 3000);
  }, []);

  // Fetch workspace recording settings
  const fetchRecordingSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/twilio/settings/recording');
      if (res.ok) {
        const data = await res.json();
        const isAuto = Boolean(data.autoRecordingEnabled);
        setAutoRecordingEnabled(isAuto);
        setRecordCallPreference(isAuto);
      }
    } catch (err) {
      console.warn('Error fetching workspace recording settings:', err);
    }
  }, []);

  // Initialize Twilio.Device (client-side only with concurrency-safe single promise)
  const initDevice = useCallback(async (): Promise<boolean> => {
    if (typeof window === 'undefined') return false;
    if (!isSessionRegistered || isDisplaced) {
      console.warn('[Twilio Device] Cannot initialize: session is not registered or is displaced.');
      return false;
    }

    if (deviceRef.current && (deviceRef.current.state === 'registered' || deviceRef.current.state === 'ready')) {
      setDeviceStatus('ready');
      return true;
    }

    if (initPromiseRef.current) {
      return initPromiseRef.current;
    }

    setDeviceStatus('initializing');
    setErrorMessage(null);

    const initPromise = (async (): Promise<boolean> => {
      try {
        // 1. Fetch access token and workspace recording preferences
        const [tokenData] = await Promise.all([
          fetchVoiceAccessToken(),
          fetchRecordingSettings(),
        ]);

        if (!tokenData || !tokenData.token) {
          setDeviceStatus('error');
          setErrorMessage('Failed to retrieve Twilio Voice token from server.');
          return false;
        }

        setIdentity(tokenData.identity);

        // 2. Dynamically import Twilio Voice SDK on client side only
        const { Device, Call } = await import('@twilio/voice-sdk');

        // 3. Create Device instance
        const device = new Device(tokenData.token, {
          logLevel: 1,
          codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
        });

        // 4. Register Device event listeners
        device.on('registered', () => {
          setDeviceStatus('ready');
        });

        device.on('unregistered', () => {
          setDeviceStatus('uninitialized');
        });

        device.on('error', (err: any) => {
          console.error('Twilio Device Error:', err);
          setErrorMessage(err.message || 'Twilio Device encountered an error.');
          setDeviceStatus('error');
        });

        device.on('tokenWillExpire', async () => {
          console.log('Twilio Access Token expiring, refreshing...');
          const freshTokenData = await fetchVoiceAccessToken();
          if (freshTokenData?.token && deviceRef.current) {
            deviceRef.current.updateToken(freshTokenData.token);
          }
        });

        // Register listener for incoming calls from company number
        device.on('incoming', (incomingCall: any) => {
          console.log('[Twilio Device] Incoming browser call detected:', incomingCall.parameters);

          if (isDisplaced || !isSessionRegistered || activeCallRef.current || callState === 'connecting' || callState === 'ringing' || callState === 'connected') {
            console.log('[Twilio Device] Rejecting incoming call (displaced/unregistered/busy).');
            try {
              incomingCall.reject();
            } catch (e) {
              console.warn('[Twilio Device] Error rejecting incoming call:', e);
            }
            return;
          }

          incomingCallRef.current = incomingCall;
          const callerNum = incomingCall.parameters?.From || 'Customer';
          setIncomingCaller(callerNum);
          setCallState('ringing');

          const currentRingtoneKey = (profileRef.current as any)?.ringtone_name || 'classic';
          const currentRingtoneVol = (profileRef.current as any)?.ringtone_volume ?? 80;
          ringtoneEngine.startIncomingRingtone(currentRingtoneKey, currentRingtoneVol);

          incomingCall.on('accept', () => {
            console.log('[Twilio Device] Incoming call accepted by agent.');
            ringtoneEngine.stopIncomingRingtone();
            setCallState('connected');
            setIncomingCaller(null);
            startTimer();
            activeCallRef.current = incomingCall;

            const dbCallId =
              incomingCall.customParameters?.get?.('dbCallId') ||
              incomingCall.customParameters?.dbCallId ||
              incomingCall.parameters?.dbCallId ||
              incomingCall.parameters?.DbCallId ||
              '';

            if (dbCallId) {
              fetch(`/api/calls/${encodeURIComponent(dbCallId)}/answer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
              })
                .then(async (res) => {
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok || data.error?.includes('already answered')) {
                    console.warn('[Browser Answer Endpoint Rejection]', data);
                    try {
                      incomingCall.disconnect();
                    } catch (e) {}
                    activeCallRef.current = null;
                    stopTimer();
                    setCallState('ended');
                    setErrorMessage(data.error || 'Call already answered by another agent.');
                    resetCallStateAfterDelay();
                  } else {
                    console.log('[Browser Answer Endpoint Success]', data);
                  }
                })
                .catch((err) => {
                  console.error('[Browser Answer Endpoint Error]', err);
                });
            }
          });

          incomingCall.on('disconnect', () => {
            console.log('[Twilio Device] Incoming call disconnected.');
            ringtoneEngine.stopIncomingRingtone();
            stopTimer();
            setCallState('ended');
            setIncomingCaller(null);
            resetCallStateAfterDelay();

            if (isDisplaced) {
              if (deviceRef.current) {
                try { deviceRef.current.destroy(); } catch (e) {}
                deviceRef.current = null;
              }
              displaceSession('Your account was signed in on another device.');
            }
          });

          incomingCall.on('cancel', () => {
            console.log('[Twilio Device] Incoming call canceled.');
            ringtoneEngine.stopIncomingRingtone();
            stopTimer();
            setCallState('idle');
            setIncomingCaller(null);
            incomingCallRef.current = null;
          });
        });

        // Register device asynchronously and wait for ready state
        await device.register();
        deviceRef.current = device;
        setDeviceStatus('ready');
        return true;
      } catch (err: any) {
        console.error('Error initializing Twilio Device:', err);
        setDeviceStatus('error');
        setErrorMessage(err.message || 'Initialization failed.');
        return false;
      } finally {
        initPromiseRef.current = null;
      }
    })();

    initPromiseRef.current = initPromise;
    return initPromise;
  }, [isSessionRegistered, isDisplaced, fetchRecordingSettings, startTimer, stopTimer, resetCallStateAfterDelay, displaceSession]);

  // Handle Displacement Side-Effects for Telephony
  useEffect(() => {
    if (isDisplaced) {
      console.warn('[useTwilioDevice] Session displacement side-effect triggered.');
      ringtoneEngine.stopIncomingRingtone();

      if (callState === 'connected') {
        if (deviceRef.current) {
          try {
            deviceRef.current.unregister();
          } catch (e) {}
        }
      } else {
        if (incomingCallRef.current) {
          try { incomingCallRef.current.reject(); } catch (e) {}
          incomingCallRef.current = null;
        }
        if (activeCallRef.current) {
          try { activeCallRef.current.disconnect(); } catch (e) {}
          activeCallRef.current = null;
        }
        if (deviceRef.current) {
          try { deviceRef.current.destroy(); } catch (e) {}
          deviceRef.current = null;
        }
        setDeviceStatus('uninitialized');
        displaceSession('Your account was signed in on another device.');
      }
    }
  }, [isDisplaced, callState, displaceSession]);

  // Make Outbound Call with Strict Device Readiness & Debounced Setup
  const makeCall = useCallback(
    async (destinationNumber: string, contactName?: string): Promise<boolean> => {
      setErrorMessage(null);

      // Debounce duplicate Call button clicks or concurrent call setups
      if (isCallSetupInProgressRef.current) {
        console.warn('[useTwilioDevice] Call setup is already in progress. Ignoring duplicate click.');
        return false;
      }

      if (callState === 'connecting' || callState === 'ringing' || callState === 'connected') {
        console.warn('[useTwilioDevice] Agent already has active or connecting call.');
        return false;
      }

      isCallSetupInProgressRef.current = true;

      try {
        if (isDisplaced) {
          setErrorMessage('Session has been displaced by another login on another device.');
          return false;
        }

        if (!isSessionRegistered) {
          setErrorMessage('Active session registration pending. Please try again.');
          return false;
        }

        // 1. Validate destination phone number
        const validation = normalizeE164PhoneNumber(destinationNumber);
        if (!validation.isValid || !validation.normalized) {
          setErrorMessage(validation.error || 'Invalid phone number format.');
          return false;
        }

        setActiveDestination(validation.normalized);
        setActiveCallContactName(contactName || null);

        // Check if destination contact is blocked
        try {
          const checkRes = await fetch(`/api/contacts?query=${encodeURIComponent(validation.normalized)}`);
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            const matchingContact = (checkData.contacts || []).find((c: any) => c.phone === validation.normalized);
            if (matchingContact && matchingContact.is_blocked) {
              const displayName = matchingContact.full_name || validation.normalized;
              setErrorMessage(`${displayName} is blocked. Unblock this contact before calling.`);
              setCallState('failed');
              resetCallStateAfterDelay();
              return false;
            }
          }
        } catch (checkErr) {
          console.warn('Error checking contact block status before call:', checkErr);
        }

        // 2. Request microphone permission
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
        } catch (micErr: any) {
          console.warn('Microphone permission denied:', micErr);
          setCallState('permission_denied');
          setErrorMessage('Microphone access denied. Please allow microphone access in your browser settings.');
          return false;
        }

        // 3. STRICT DEVICE READINESS INVARIANT:
        // NO server-side call setup may begin until Device is authoritatively initialized and registered.
        let isReady = false;
        if (deviceRef.current && (deviceRef.current.state === 'registered' || deviceRef.current.state === 'ready')) {
          isReady = true;
        } else {
          setErrorMessage('Initializing Voice Device...');
          isReady = await initDevice();
        }

        if (!isReady || !deviceRef.current) {
          setErrorMessage('Failed to initialize Twilio Device. Check connection and try again.');
          setCallState('failed');
          resetCallStateAfterDelay();
          return false;
        }

        // 4. Create database call record in Supabase ONLY AFTER Device is verified ready
        let dbCallId = '';
        try {
          const createRes = await fetch('/api/twilio/calls/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              destination: validation.normalized,
              recordCall: recordCallPreference,
            }),
          });

          const createData = await createRes.json().catch(() => ({}));

          if (!createRes.ok) {
            const err = createData.error || 'Failed to place outbound call.';
            setErrorMessage(err);
            setCallState('failed');
            resetCallStateAfterDelay();
            return false;
          } else {
            dbCallId = createData.callId || '';
          }
        } catch (dbErr) {
          console.warn('Exception creating initial call record in database:', dbErr);
          setErrorMessage('Network error creating call record.');
          setCallState('failed');
          resetCallStateAfterDelay();
          return false;
        }

        // 5. Connect outbound call via Twilio SDK ONLY AFTER calls/create succeeds
        try {
          setCallState('connecting');

          const connectParams: Record<string, string> = {
            To: validation.normalized,
            recordCall: String(recordCallPreference),
          };
          if (dbCallId) {
            connectParams.dbCallId = dbCallId;
          }

          const call = await deviceRef.current.connect({
            params: connectParams,
          });

          activeCallRef.current = call;

          // Attach Call Event Listeners
          call.on('ringing', () => {
            setCallState('ringing');
          });

          call.on('accept', () => {
            setCallState('connected');
            startTimer();
          });

          call.on('disconnect', () => {
            setCallState('ended');
            stopTimer();
            resetCallStateAfterDelay();

            if (isDisplaced) {
              if (deviceRef.current) {
                try { deviceRef.current.destroy(); } catch (e) {}
                deviceRef.current = null;
              }
              displaceSession('Your account was signed in on another device.');
            }
          });

          call.on('reject', () => {
            setCallState('failed');
            setErrorMessage('Call was rejected by destination.');
            stopTimer();
            resetCallStateAfterDelay();
          });

          call.on('error', (callErr: any) => {
            console.error('Call Error:', callErr);
            setCallState('failed');
            setErrorMessage(callErr.message || 'Call failed due to a network error.');
            stopTimer();
            resetCallStateAfterDelay();
          });

          return true;
        } catch (connErr: any) {
          console.error('Error connecting call:', connErr);
          setCallState('failed');
          setErrorMessage(connErr.message || 'Unable to place call.');
          return false;
        }
      } finally {
        isCallSetupInProgressRef.current = false;
      }
    },
    [isDisplaced, isSessionRegistered, deviceStatus, callState, initDevice, recordCallPreference, startTimer, stopTimer, resetCallStateAfterDelay, displaceSession]
  );

  // Accept Incoming Call
  const acceptIncomingCall = useCallback(() => {
    ringtoneEngine.stopIncomingRingtone();
    if (incomingCallRef.current) {
      incomingCallRef.current.accept();
    }
  }, []);

  // Reject Incoming Call
  const rejectIncomingCall = useCallback(() => {
    ringtoneEngine.stopIncomingRingtone();
    if (incomingCallRef.current) {
      incomingCallRef.current.reject();
      incomingCallRef.current = null;
      setCallState('idle');
      setIncomingCaller(null);
    }
  }, []);

  // End Call
  const endCall = useCallback(() => {
    ringtoneEngine.stopIncomingRingtone();
    if (incomingCallRef.current) {
      incomingCallRef.current.reject();
      incomingCallRef.current = null;
    }
    if (activeCallRef.current) {
      activeCallRef.current.disconnect();
      activeCallRef.current = null;
    }
    setCallState('ended');
    stopTimer();
    resetCallStateAfterDelay();

    if (isDisplaced) {
      if (deviceRef.current) {
        try { deviceRef.current.destroy(); } catch (e) {}
        deviceRef.current = null;
      }
      displaceSession('Your account was signed in on another device.');
    }
  }, [isDisplaced, displaceSession, stopTimer, resetCallStateAfterDelay]);

  // Toggle Mute
  const toggleMute = useCallback(() => {
    if (activeCallRef.current) {
      const nextMute = !isMuted;
      activeCallRef.current.mute(nextMute);
      setIsMuted(nextMute);
    }
  }, [isMuted]);

  // Toggle Hold / Resume
  const toggleHold = useCallback(async () => {
    const nextHold = !isHeld;
    try {
      const callSid = activeCallRef.current?.parameters?.CallSid || activeCallRef.current?.customParameters?.get?.('CallSid') || '';
      const dbCallId = activeCallRef.current?.customParameters?.get?.('dbCallId') || activeCallRef.current?.parameters?.dbCallId || '';

      const res = await fetch('/api/twilio/calls/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callSid,
          dbCallId,
          hold: nextHold,
        }),
      });

      if (res.ok) {
        setIsHeld(nextHold);
      }
    } catch (err) {
      console.error('Error toggling call hold state:', err);
    }
  }, [isHeld]);

  const clearError = useCallback(() => {
    setErrorMessage(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (activeCallRef.current) {
        activeCallRef.current.disconnect();
      }
      if (deviceRef.current) {
        deviceRef.current.destroy();
        deviceRef.current = null;
      }
    };
  }, []);

  return {
    deviceStatus,
    callState,
    callDuration,
    isMuted,
    isHeld,
    isTransferModalOpen,
    errorMessage,
    identity,
    autoRecordingEnabled,
    recordCallPreference,
    incomingCaller,
    activeDestination,
    activeCallContactName,
    isDisplaced,
    displacedNotice,
    setRecordCallPreference,
    initDevice,
    makeCall,
    acceptIncomingCall,
    rejectIncomingCall,
    endCall,
    toggleMute,
    toggleHold,
    setIsTransferModalOpen,
    clearError,
  };
}
