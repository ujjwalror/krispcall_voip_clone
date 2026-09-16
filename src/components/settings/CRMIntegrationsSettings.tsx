'use client';

import React, { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  ShieldAlert,
  Loader2,
  Check,
  Unplug,
  Zap,
} from 'lucide-react';
import { CRMConnectionSummary } from '@/lib/integrations/crm/types';
import { useSearchParams } from 'next/navigation';

/**
 * Default fallback catalogue to ensure provider cards render IMMEDIATELY,
 * even if DB migration is pending, API status fails, or credentials are unconfigured.
 */
const DEFAULT_INTEGRATIONS_CATALOGUE: CRMConnectionSummary[] = [
  {
    provider: 'zoho',
    name: 'Zoho CRM',
    description: 'Connect your Zoho CRM account to sync leads, contacts, calls and customer context.',
    status: 'disconnected',
    isAvailable: true,
  },
  {
    provider: 'hubspot',
    name: 'HubSpot',
    description: 'Inbound marketing, sales CRM, and customer service synchronization.',
    status: 'coming_soon',
    isAvailable: false,
  },
  {
    provider: 'salesforce',
    name: 'Salesforce',
    description: 'Enterprise Cloud CRM contacts, leads, opportunities, and activity logging.',
    status: 'coming_soon',
    isAvailable: false,
  },
  {
    provider: 'pipedrive',
    name: 'Pipedrive',
    description: 'Sales pipeline, deal tracking, and activity synchronization.',
    status: 'coming_soon',
    isAvailable: false,
  },
  {
    provider: 'clickup',
    name: 'ClickUp',
    description: 'Task management and CRM-style workflow integration.',
    status: 'coming_soon',
    isAvailable: false,
  },
];

export function CRMIntegrationsSettings() {
  const searchParams = useSearchParams();
  const [integrations, setIntegrations] = useState<CRMConnectionSummary[]>(DEFAULT_INTEGRATIONS_CATALOGUE);
  const [userRole, setUserRole] = useState<string>('agent');
  const [isLoadingStatus, setIsLoadingStatus] = useState<boolean>(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [isDisconnecting, setIsDisconnecting] = useState<boolean>(false);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchStatus = async () => {
    setIsLoadingStatus(true);
    setStatusError(null);
    try {
      const res = await fetch('/api/integrations/crm/status');
      const data = await res.json();
      if (res.ok && data.success) {
        setIntegrations(data.integrations || DEFAULT_INTEGRATIONS_CATALOGUE);
        setUserRole(data.userRole || 'agent');
      } else {
        setStatusError('Connection status temporarily unavailable.');
      }
    } catch (err) {
      console.warn('[CRM UI] Failed to fetch CRM status from API:', err);
      setStatusError('Connection status temporarily unavailable.');
    } finally {
      setIsLoadingStatus(false);
    }
  };

  useEffect(() => {
    fetchStatus();

    const connectedParam = searchParams.get('connected');
    const errorParam = searchParams.get('error');

    if (connectedParam === 'zoho') {
      setActionMessage({ type: 'success', text: 'Zoho CRM successfully connected!' });
    } else if (errorParam) {
      setActionMessage({ type: 'error', text: decodeURIComponent(errorParam) });
    }
  }, [searchParams]);

  const handleConnectZoho = () => {
    window.location.href = '/api/integrations/crm/zoho/connect';
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setActionMessage(null);
    try {
      const res = await fetch('/api/integrations/crm/zoho/test', { method: 'POST' });
      const data = await res.json();

      if (res.ok && data.success) {
        setActionMessage({
          type: 'success',
          text: `Connection test passed! ${data.orgName ? `(${data.orgName})` : ''}`,
        });
        await fetchStatus();
      } else {
        setActionMessage({
          type: 'error',
          text: data.message || 'Connection test failed.',
        });
        await fetchStatus();
      }
    } catch (err: any) {
      setActionMessage({ type: 'error', text: 'Failed to test connection.' });
    } finally {
      setIsTesting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect Zoho CRM? Synchronization features will stop.')) {
      return;
    }
    setIsDisconnecting(true);
    setActionMessage(null);
    try {
      const res = await fetch('/api/integrations/crm/zoho/disconnect', { method: 'POST' });
      const data = await res.json();

      if (res.ok && data.success) {
        setActionMessage({ type: 'success', text: 'Zoho CRM disconnected successfully.' });
        await fetchStatus();
      } else {
        setActionMessage({ type: 'error', text: data.error || 'Failed to disconnect.' });
      }
    } catch (err) {
      setActionMessage({ type: 'error', text: 'Error disconnecting Zoho CRM.' });
    } finally {
      setIsDisconnecting(false);
    }
  };

  const isAdmin = userRole === 'admin';

  return (
    <div className="space-y-6">
      {/* Clean Public SaaS Header */}
      <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
        <CardHeader>
          <CardTitle className="text-base font-semibold flex items-center gap-2 text-slate-900 dark:text-slate-100">
            <Zap className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>CRM Integrations</span>
          </CardTitle>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Connect your CRM to keep customer information, calls and conversations connected with your team's workflow.
          </p>
        </CardHeader>
      </Card>

      {/* Action Banners */}
      {actionMessage && (
        <div
          className={`p-3.5 rounded-lg text-xs font-medium border flex items-center justify-between animate-in fade-in ${
            actionMessage.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
              : 'bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300 border-rose-200 dark:border-rose-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {actionMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
            )}
            <span>{actionMessage.text}</span>
          </div>
          <button
            onClick={() => setActionMessage(null)}
            className="text-xs opacity-70 hover:opacity-100 font-bold px-1"
          >
            ✕
          </button>
        </div>
      )}

      {/* Status Warning Banner (if API/DB pending) */}
      {statusError && (
        <div className="p-3 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <span>{statusError}</span>
          </div>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={fetchStatus}
              disabled={isLoadingStatus}
              className="text-[11px] h-7 px-2 flex items-center gap-1"
            >
              <RefreshCw className={`w-3 h-3 ${isLoadingStatus ? 'animate-spin' : ''}`} />
              <span>Retry Status</span>
            </Button>
          )}
        </div>
      )}

      {/* Provider Catalogue Grid — ALWAYS VISIBLE */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {integrations.map((item) => {
          const isZoho = item.provider === 'zoho';
          const isConnected = item.status === 'connected';
          const isError = item.status === 'error' || item.status === 'reauthorization_required';

          return (
            <Card
              key={item.provider}
              className={`border transition-all ${
                isConnected
                  ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/20 dark:bg-emerald-950/10'
                  : isError
                  ? 'border-amber-200 dark:border-amber-900/60 bg-amber-50/20 dark:bg-amber-950/10'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/50'
              }`}
            >
              <div className="p-4 space-y-4">
                {/* Provider Header: Name & Status Badge */}
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm ${
                        isZoho
                          ? 'bg-amber-500 text-white dark:bg-amber-600 shadow-xs'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {item.name.substring(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                        {item.name}
                      </h3>
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 block">
                        {item.isAvailable ? 'Active Integration' : 'Coming Soon'}
                      </span>
                    </div>
                  </div>

                  {/* Status Indicator Badge */}
                  <div>
                    {isLoadingStatus && isZoho ? (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
                        <span>Checking...</span>
                      </span>
                    ) : !item.isAvailable ? (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                        Coming Soon
                      </span>
                    ) : isConnected ? (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800 flex items-center gap-1">
                        <Check className="w-3 h-3" />
                        Connected
                      </span>
                    ) : isError ? (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-800 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        Reauth Required
                      </span>
                    ) : (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                        Not connected
                      </span>
                    )}
                  </div>
                </div>

                {/* Description */}
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed min-h-[32px]">
                  {item.description}
                </p>

                {/* Connected Details Panel (Zoho) */}
                {isConnected && isZoho && (
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800/80 space-y-1.5 text-xs text-slate-700 dark:text-slate-300">
                    {item.externalOrgName && (
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500 dark:text-slate-400">Organization:</span>
                        <span className="font-semibold">{item.externalOrgName}</span>
                      </div>
                    )}
                    {item.externalAccountDisplay && (
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500 dark:text-slate-400">Account:</span>
                        <span className="font-mono text-[11px] font-medium">{item.externalAccountDisplay}</span>
                      </div>
                    )}
                    {item.connectedByName && (
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500 dark:text-slate-400">Connected by:</span>
                        <span>{item.connectedByName}</span>
                      </div>
                    )}
                    {item.connectedAt && (
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500 dark:text-slate-400">Connected on:</span>
                        <span>{new Date(item.connectedAt).toLocaleDateString()}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Action Bar */}
                <div className="pt-2 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between">
                  {!item.isAvailable ? (
                    <Button variant="outline" size="sm" disabled className="w-full text-xs opacity-60 cursor-not-allowed">
                      Coming Soon
                    </Button>
                  ) : isConnected ? (
                    <div className="flex items-center gap-2 w-full justify-between">
                      {isAdmin ? (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleTestConnection}
                            disabled={isTesting}
                            className="text-xs flex items-center gap-1.5"
                          >
                            {isTesting ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="w-3.5 h-3.5 text-blue-500" />
                            )}
                            <span>Test Connection</span>
                          </Button>

                          <Button
                            variant="danger"
                            size="sm"
                            onClick={handleDisconnect}
                            disabled={isDisconnecting}
                            className="text-xs flex items-center gap-1.5"
                          >
                            {isDisconnecting ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Unplug className="w-3.5 h-3.5" />
                            )}
                            <span>Disconnect</span>
                          </Button>
                        </>
                      ) : (
                        <span className="text-[11px] text-slate-400 flex items-center gap-1 italic">
                          <ShieldAlert className="w-3.5 h-3.5" />
                          Admin required to manage connection
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="w-full">
                      {isAdmin ? (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={handleConnectZoho}
                          className="w-full text-xs font-semibold flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white shadow-xs"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>Connect Zoho CRM</span>
                        </Button>
                      ) : (
                        <span className="text-[11px] text-slate-400 flex items-center justify-center gap-1 italic py-1">
                          <ShieldAlert className="w-3.5 h-3.5" />
                          Admin access required to connect integrations
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
