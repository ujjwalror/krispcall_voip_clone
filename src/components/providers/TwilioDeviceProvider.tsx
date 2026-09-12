'use client';

import React, { createContext, useContext, useEffect } from 'react';
import { useTwilioDevice, UseTwilioDeviceReturn } from '@/hooks/useTwilioDevice';
import { GlobalIncomingCall } from '@/components/call/GlobalIncomingCall';

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
