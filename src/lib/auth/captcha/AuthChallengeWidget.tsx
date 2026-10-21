'use client';

import React, {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  useCallback,
} from 'react';
import {
  AuthChallengeState,
  AuthChallengeWidgetProps,
  AuthChallengeWidgetRef,
} from './types';
import {
  getTurnstileSiteKey,
  isTurnstileConfigured,
  isTurnstileTestMode,
  TURNSTILE_TEST_KEYS,
  assertClientEnvironmentSecurity,
  SAFE_CAPTCHA_UNAVAILABLE_MESSAGE,
} from './config';
import { Shield, ShieldAlert, ShieldCheck, Loader2 } from 'lucide-react';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement | string,
        options: {
          sitekey: string;
          action?: string;
          theme?: 'light' | 'dark' | 'auto';
          callback?: (token: string) => void;
          'error-callback'?: (errorCode: string) => void;
          'expired-callback'?: () => void;
        }
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

/**
 * Reusable Cloudflare Turnstile Challenge Widget.
 * Invariant SEC6-003 / SEC6-004: Challenge tokens remain ephemeral in React memory.
 * Never write challenge tokens to localStorage, cookies, or telemetry logs.
 */
export const AuthChallengeWidget = forwardRef<
  AuthChallengeWidgetRef,
  AuthChallengeWidgetProps
>(function AuthChallengeWidget(
  {
    onVerify,
    onExpire,
    onError,
    action = 'auth',
    theme = 'dark',
    className = '',
    disabled = false,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const tokenHeldRef = useRef<boolean>(false);

  const [state, setState] = useState<AuthChallengeState>('IDLE');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Security guard against accidental secret leakage into client bundle
  useEffect(() => {
    assertClientEnvironmentSecurity();
  }, []);

  const handleVerify = useCallback(
    (token: string) => {
      tokenHeldRef.current = true;
      setState('VERIFIED');
      setErrorMessage(null);
      onVerify(token);
    },
    [onVerify]
  );

  const handleExpire = useCallback(() => {
    tokenHeldRef.current = false;
    setState('EXPIRED');
    setErrorMessage('Verification expired. Please verify again.');
    if (onExpire) onExpire();
  }, [onExpire]);

  const handleError = useCallback(
    (err: string) => {
      tokenHeldRef.current = false;
      setState('ERROR');
      setErrorMessage(SAFE_CAPTCHA_UNAVAILABLE_MESSAGE);
      if (onError) onError(err);
    },
    [onError]
  );

  const resetWidget = useCallback(() => {
    tokenHeldRef.current = false;
    setErrorMessage(null);

    if (isTurnstileTestMode()) {
      const siteKey = getTurnstileSiteKey();
      if (siteKey === TURNSTILE_TEST_KEYS.ALWAYS_BLOCKS) {
        setState('ERROR');
        handleError('test_always_blocks');
        return;
      }
      setState('VERIFIED');
      handleVerify('mock_turnstile_test_token_' + Date.now());
      return;
    }

    if (window.turnstile && widgetIdRef.current) {
      try {
        window.turnstile.reset(widgetIdRef.current);
        setState('READY');
      } catch (e) {
        setState('READY');
      }
    } else {
      setState('READY');
    }
  }, [handleError, handleVerify]);

  useImperativeHandle(
    ref,
    () => ({
      reset: resetWidget,
      getState: () => state,
      hasToken: () => tokenHeldRef.current,
    }),
    [resetWidget, state]
  );

  useEffect(() => {
    let isMounted = true;
    const siteKey = getTurnstileSiteKey();

    // 1. Missing site key handling:
    // In production, missing CAPTCHA site key must produce an explicit controlled error state (AUTH-CAPTCHA-FAILURE-001)
    if (!siteKey) {
      if (process.env.NODE_ENV === 'production') {
        setState('ERROR');
        setErrorMessage(SAFE_CAPTCHA_UNAVAILABLE_MESSAGE);
        if (onError) onError('missing_turnstile_site_key');
        return;
      } else {
        // In local dev without site key: run mock pass mode
        setState('VERIFIED');
        handleVerify('mock_turnstile_dev_token_' + Date.now());
        return;
      }
    }

    // 2. Test mode handling:
    if (isTurnstileTestMode()) {
      if (siteKey === TURNSTILE_TEST_KEYS.ALWAYS_BLOCKS) {
        setState('ERROR');
        handleError('test_always_blocks');
      } else {
        setState('VERIFIED');
        handleVerify('mock_turnstile_test_token_' + Date.now());
      }
      return;
    }

    // 3. Live script loading for Cloudflare Turnstile
    setState('LOADING');

    const renderTurnstile = () => {
      if (!isMounted || !containerRef.current || !window.turnstile) return;

      try {
        if (widgetIdRef.current) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }

        const id = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme,
          callback: (token: string) => {
            if (isMounted) handleVerify(token);
          },
          'error-callback': (code: string) => {
            if (isMounted) handleError(code);
          },
          'expired-callback': () => {
            if (isMounted) handleExpire();
          },
        });

        widgetIdRef.current = id;
        setState('READY');
      } catch (err: any) {
        if (isMounted) {
          handleError(err?.message || 'render_failed');
        }
      }
    };

    if (window.turnstile) {
      renderTurnstile();
    } else {
      // Load script if not already in DOM
      const existingScript = document.querySelector('script[src*="turnstile/v0/api.js"]');
      if (!existingScript) {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.onload = () => {
          if (isMounted) renderTurnstile();
        };
        script.onerror = () => {
          if (isMounted) handleError('script_load_failed');
        };
        document.head.appendChild(script);
      } else {
        if (window.turnstile) {
          renderTurnstile();
        } else {
          existingScript.addEventListener('load', renderTurnstile);
          const pollTimer = setInterval(() => {
            if (!isMounted) {
              clearInterval(pollTimer);
              return;
            }
            if (window.turnstile) {
              clearInterval(pollTimer);
              renderTurnstile();
            }
          }, 50);
          setTimeout(() => clearInterval(pollTimer), 5000);
        }
      }
    }

    return () => {
      isMounted = false;
      if (window.turnstile && widgetIdRef.current) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Ignore cleanup errors
        }
        widgetIdRef.current = null;
      }
    };
  }, [action, handleError, handleExpire, handleVerify, onError, theme]);

  // Test mode indicator (does not render external iframe)
  if (isTurnstileTestMode()) {
    return (
      <div
        data-testid="turnstile-test-widget"
        className={`p-2.5 rounded-lg border text-xs flex items-center justify-between ${
          state === 'VERIFIED'
            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
            : 'bg-rose-500/10 border-rose-500/20 text-rose-300'
        } ${className}`}
      >
        <div className="flex items-center gap-2">
          {state === 'VERIFIED' ? (
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
          )}
          <span>Bot Protection Test Mode: {state}</span>
        </div>
        <button
          type="button"
          onClick={resetWidget}
          className="text-[11px] underline text-slate-400 hover:text-slate-200"
        >
          Reset
        </button>
      </div>
    );
  }

  return (
    <div className={`space-y-2 ${className}`}>
      <div
        ref={containerRef}
        data-testid="turnstile-container"
        className={`min-h-[65px] flex items-center justify-center rounded-lg ${
          disabled ? 'opacity-50 pointer-events-none' : ''
        }`}
      >
        {state === 'LOADING' && (
          <div className="flex items-center gap-2 text-xs text-slate-400 py-4">
            <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
            <span>Verifying browser security...</span>
          </div>
        )}
      </div>

      {errorMessage && (
        <div
          data-testid="turnstile-error-banner"
          className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={resetWidget}
            className="text-[11px] underline text-rose-300 hover:text-white shrink-0"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
});
