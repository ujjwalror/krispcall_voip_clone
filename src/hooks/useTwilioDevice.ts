'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchVoiceAccessToken } from '@/services/voice/client';
import { normalizeE164PhoneNumber } from '@/lib/utils';

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
  errorMessage: string | null;
  identity: string | null;
  autoRecordingEnabled: boolean;
  recordCallPreference: boolean;
  incomingCaller: string | null;
  setRecordCallPreference: (val: boolean) => void;
  initDevice: () => Promise<void>;
  makeCall: (destinationNumber: string) => Promise<boolean>;
  acceptIncomingCall: () => void;
  rejectIncomingCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  clearError: () => void;
}

export function useTwilioDevice(): UseTwilioDeviceReturn {
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>('uninitialized');
  const [callState, setCallState] = useState<CallState>('idle');
  const [callDuration, setCallDuration] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const [autoRecordingEnabled, setAutoRecordingEnabled] = useState<boolean>(true);
  const [recordCallPreference, setRecordCallPreference] = useState<boolean>(true);
  const [incomingCaller, setIncomingCaller] = useState<string | null>(null);

  const deviceRef = useRef<any>(null);
  const activeCallRef = useRef<any>(null);
  const incomingCallRef = useRef<any>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

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

  // Initialize Twilio.Device (client-side only)
  const initDevice = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (deviceRef.current) return; // Prevent duplicate instances

    setDeviceStatus('initializing');
    setErrorMessage(null);

    try {
      // 1. Fetch access token and workspace recording preferences
      const [tokenData] = await Promise.all([
        fetchVoiceAccessToken(),
        fetchRecordingSettings(),
      ]);

      if (!tokenData || !tokenData.token) {
        setDeviceStatus('error');
        setErrorMessage('Failed to retrieve Twilio Voice token from server.');
        return;
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
        incomingCallRef.current = incomingCall;
        const callerNum = incomingCall.parameters?.From || 'Customer';
        setIncomingCaller(callerNum);
        setCallState('ringing');

        incomingCall.on('accept', () => {
          console.log('[Twilio Device] Incoming call accepted.');
          setCallState('connected');
          startTimer();
          activeCallRef.current = incomingCall;
        });

        incomingCall.on('disconnect', () => {
          console.log('[Twilio Device] Incoming call disconnected.');
          stopTimer();
          setCallState('ended');
          resetCallStateAfterDelay();
        });

        incomingCall.on('cancel', () => {
          console.log('[Twilio Device] Incoming call canceled.');
          stopTimer();
          setCallState('idle');
          setIncomingCaller(null);
          incomingCallRef.current = null;
        });
      });

      // Register device
      await device.register();
      deviceRef.current = device;
    } catch (err: any) {
      console.error('Error initializing Twilio Device:', err);
      setDeviceStatus('error');
      setErrorMessage(err.message || 'Initialization failed.');
    }
  }, [fetchRecordingSettings, startTimer, stopTimer, resetCallStateAfterDelay]);

  // Make Outbound Call
  const makeCall = useCallback(
    async (destinationNumber: string): Promise<boolean> => {
      setErrorMessage(null);

      // 1. Validate destination phone number
      const validation = normalizeE164PhoneNumber(destinationNumber);
      if (!validation.isValid || !validation.normalized) {
        setErrorMessage(validation.error || 'Invalid phone number format.');
        return false;
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

      // 3. Ensure Device is initialized
      if (!deviceRef.current || deviceStatus !== 'ready') {
        setErrorMessage('Twilio Device is not ready. Initializing device...');
        await initDevice();
        if (!deviceRef.current) {
          setErrorMessage('Failed to initialize Twilio Device. Check connection and try again.');
          return false;
        }
      }

      // 4. Create database call record in Supabase with recordCall preference (Phase 6 & 7)
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
        if (createRes.ok) {
          const createData = await createRes.json();
          dbCallId = createData.callId || '';
        }
      } catch (dbErr) {
        console.warn('Could not create initial call record in database:', dbErr);
      }

      // 5. Connect outbound call via Twilio SDK
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
    },
    [deviceStatus, initDevice, recordCallPreference, startTimer, stopTimer, resetCallStateAfterDelay]
  );

  // Accept Incoming Call
  const acceptIncomingCall = useCallback(() => {
    if (incomingCallRef.current) {
      incomingCallRef.current.accept();
    }
  }, []);

  // Reject Incoming Call
  const rejectIncomingCall = useCallback(() => {
    if (incomingCallRef.current) {
      incomingCallRef.current.reject();
      incomingCallRef.current = null;
      setCallState('idle');
      setIncomingCaller(null);
    }
  }, []);

  // End Call
  const endCall = useCallback(() => {
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
  }, [stopTimer, resetCallStateAfterDelay]);

  // Toggle Mute
  const toggleMute = useCallback(() => {
    if (activeCallRef.current) {
      const nextMute = !isMuted;
      activeCallRef.current.mute(nextMute);
      setIsMuted(nextMute);
    }
  }, [isMuted]);

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
    errorMessage,
    identity,
    autoRecordingEnabled,
    recordCallPreference,
    incomingCaller,
    setRecordCallPreference,
    initDevice,
    makeCall,
    acceptIncomingCall,
    rejectIncomingCall,
    endCall,
    toggleMute,
    clearError,
  };
}
