'use client';

import React, { createContext, useContext, useEffect } from 'react';
import { useTwilioDevice, UseTwilioDeviceReturn } from '@/hooks/useTwilioDevice';
import { GlobalIncomingCall } from '@/components/call/GlobalIncomingCall';
import { GlobalActiveCall } from '@/components/call/GlobalActiveCall';

const TwilioDeviceContext = createContext<UseTwilioDeviceReturn | null>(null);

export function TwilioDeviceProvider({ children }: { children: React.ReactNode }) {
  const twilioDevice = useTwilioDevice();
  const { initDevice } = twilioDevice;

  useEffect(() => {
    initDevice();
  }, [initDevice]);

  return (
    <TwilioDeviceContext.Provider value={twilioDevice}>
      {children}
      <GlobalIncomingCall />
      <GlobalActiveCall />
    </TwilioDeviceContext.Provider>
  );
}

export function useTwilioDeviceContext(): UseTwilioDeviceReturn {
  const context = useContext(TwilioDeviceContext);
  if (!context) {
    throw new Error('useTwilioDeviceContext must be used within a TwilioDeviceProvider');
  }
  return context;
}
