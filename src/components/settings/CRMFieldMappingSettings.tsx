'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  Loader2,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  RotateCcw,
  Save,
  Database,
  ArrowRight,
} from 'lucide-react';
import {
  CRMFieldMetadata,
  CRMFieldMapping,
  LOCAL_VOIP_HUB_FIELDS,
  isFieldMappingCompatible,
} from '@/lib/integrations/crm/types';

interface CRMFieldMappingSettingsProps {
  provider?: 'zoho';
  userRole: string;
}

export function CRMFieldMappingSettings({
  provider = 'zoho',
  userRole,
}: CRMFieldMappingSettingsProps) {
  const [activeModule, setActiveModule] = useState<'Leads' | 'Contacts'>('Leads');
  const [fields, setFields] = useState<CRMFieldMetadata[]>([]);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  const isAdmin = userRole === 'admin';

  useEffect(() => {
    loadMetadataAndMappings(false);
  }, [provider, activeModule]);

  const loadMetadataAndMappings = async (forceRefresh = false) => {
    if (forceRefresh) setIsRefreshing(true);
    else setIsLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      // 1. Fetch metadata snapshot
      const fieldsRes = await fetch(
        `/api/integrations/crm/fields?provider=${provider}&module=${activeModule}&refresh=${forceRefresh}`
      );
      const fieldsData = await fieldsRes.json();

      if (!fieldsRes.ok) {
        throw new Error(fieldsData.error || 'Failed to fetch CRM field metadata');
      }

      setFields(fieldsData.fields || []);
      setCachedAt(fieldsData.fetchedAt || null);

      // 2. Fetch saved mappings
      const mapRes = await fetch(
        `/api/integrations/crm/mapping?provider=${provider}&module=${activeModule}`
      );
      const mapData = await mapRes.json();

      if (mapRes.ok && Array.isArray(mapData.mappings)) {
        const mapObj: Record<string, string> = {};
        for (const m of mapData.mappings) {
          if (m.localFieldKey && m.externalFieldKey) {
            mapObj[m.localFieldKey] = m.externalFieldKey;
          }
        }
        setMappings(mapObj);
      }
    } catch (err: any) {
      setError(err.message || 'Error loading field mappings');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  const handleFieldSelect = (localKey: string, externalKey: string) => {
    setMappings((prev) => ({
      ...prev,
      [localKey]: externalKey,
    }));
  };

  const handleSave = async () => {
    if (!isAdmin) return;
    setIsSaving(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const mappingList = Object.entries(mappings)
        .filter(([_, extKey]) => Boolean(extKey))
        .map(([localKey, extKey]) => ({
          localFieldKey: localKey,
          externalFieldKey: extKey,
          isEnabled: true,
        }));

      const res = await fetch('/api/integrations/crm/mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          externalModule: activeModule,
          mappings: mappingList,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save field mappings');
      }

      setSuccessMsg('Field mappings saved successfully.');
    } catch (err: any) {
      setError(err.message || 'Error saving field mappings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    if (!isAdmin) return;
    setIsResetting(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/integrations/crm/mapping/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          externalModule: activeModule,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reset field mappings');
      }

      const mapObj: Record<string, string> = {};
      if (Array.isArray(data.defaults)) {
        for (const d of data.defaults) {
          mapObj[d.localFieldKey] = d.externalFieldKey;
        }
      }
      setMappings(mapObj);
      setSuccessMsg('Reset to recommended suggestions. Click Save Field Mapping to persist.');
    } catch (err: any) {
      setError(err.message || 'Error resetting field mappings');
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl bg-slate-900 border border-slate-800">
        <div>
          <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <Database className="w-4 h-4 text-blue-400" />
            <span>CRM Field Mapping ({provider.toUpperCase()})</span>
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Map generic VoIP Hub contact fields to your connected customer CRM layout fields.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadMetadataAndMappings(true)}
            disabled={isRefreshing || isLoading}
            className="text-xs border-slate-700 text-slate-300 hover:bg-slate-800"
            title="Re-fetch field metadata snapshot from Zoho CRM"
          >
            {isRefreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            <span>Refresh CRM Fields</span>
          </Button>
        </div>
      </div>

      {/* Module Selector Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2 text-xs">
        <button
          onClick={() => setActiveModule('Leads')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
            activeModule === 'Leads'
              ? 'bg-blue-600/20 text-blue-400 border border-blue-500/40'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          Zoho Leads Module (Active)
        </button>
        <button
          onClick={() => setActiveModule('Contacts')}
          className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
            activeModule === 'Contacts'
              ? 'bg-blue-600/20 text-blue-400 border border-blue-500/40'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
          }`}
        >
          Zoho Contacts Module (Future/Prepared)
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="p-3.5 rounded-xl bg-rose-950/70 border border-rose-800 text-rose-200 text-xs flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-3.5 rounded-xl bg-emerald-950/70 border border-emerald-800 text-emerald-200 text-xs flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Main Mapping Table */}
      {isLoading ? (
        <div className="p-12 text-center text-xs text-slate-400 flex flex-col items-center justify-center gap-2 bg-slate-900/60 rounded-xl border border-slate-800">
          <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
          <span>Loading CRM field metadata snapshot...</span>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-900/60">
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 p-3 bg-slate-950/80 border-b border-slate-800 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              <div className="sm:col-span-5">VoIP Hub Generic Contact Field</div>
              <div className="hidden sm:block sm:col-span-1 text-center">→</div>
              <div className="sm:col-span-6">Target {provider.toUpperCase()} {activeModule} Field</div>
            </div>

            <div className="divide-y divide-slate-800/60 text-xs">
              {LOCAL_VOIP_HUB_FIELDS.map((local) => {
                const currentExtKey = mappings[local.key] || '';
                const selectedMetadata = fields.find((f) => f.fieldKey === currentExtKey);

                return (
                  <div key={local.key} className="grid grid-cols-1 sm:grid-cols-12 gap-3 p-3.5 items-center hover:bg-slate-950/30 transition-colors">
                    {/* Local Field */}
                    <div className="sm:col-span-5 space-y-0.5">
                      <p className="font-semibold text-slate-200">{local.label}</p>
                      <p className="text-[10px] text-slate-500 font-mono">key: {local.key} ({local.dataType})</p>
                    </div>

                    {/* Arrow */}
                    <div className="hidden sm:flex sm:col-span-1 justify-center text-slate-600">
                      <ArrowRight className="w-4 h-4" />
                    </div>

                    {/* Target Dropdown */}
                    <div className="sm:col-span-6 space-y-1">
                      <select
                        value={currentExtKey}
                        disabled={!isAdmin}
                        onChange={(e) => handleFieldSelect(local.key, e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        <option value="">-- Do Not Map --</option>
                        {fields.map((field) => {
                          const isCompatible = isFieldMappingCompatible(local.dataType, field);
                          if (!isCompatible && field.fieldKey !== currentExtKey) {
                            return null; // Hide incompatible fields from dropdown options
                          }
                          return (
                            <option
                              key={field.fieldKey}
                              value={field.fieldKey}
                              disabled={!isCompatible}
                            >
                              {field.label} ({field.fieldKey}) [{field.dataType}] {field.isRequired ? ' *[Required]' : ''} {field.isCustom ? ' [Custom]' : ''} {!field.isWritable ? ' [Read-Only]' : ''}
                            </option>
                          );
                        })}
                      </select>

                      {selectedMetadata && (
                        <div className="flex items-center gap-1.5 text-[10px]">
                          <Badge variant="neutral" size="sm">
                            Type: {selectedMetadata.dataType}
                          </Badge>
                          {selectedMetadata.isRequired && (
                            <Badge variant="rose" size="sm">
                              Required
                            </Badge>
                          )}
                          {selectedMetadata.isCustom && (
                            <Badge variant="purple" size="sm">
                              Custom Field
                            </Badge>
                          )}
                          {!isFieldMappingCompatible(local.dataType, selectedMetadata) && (
                            <Badge variant="amber" size="sm">
                              Incompatible Type
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Action Footer */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 rounded-xl bg-slate-950/60 border border-slate-800">
            <div className="text-[11px] text-slate-500 font-mono">
              {cachedAt ? `Metadata Snapshot: ${new Date(cachedAt).toLocaleString()}` : 'Metadata from live CRM'}
            </div>

            {isAdmin ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleReset}
                  disabled={isResetting || isSaving}
                  className="text-xs"
                >
                  {isResetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 text-slate-400" />}
                  <span>Reset Defaults</span>
                </Button>
                <Button
                  variant="success"
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="text-xs"
                >
                  {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  <span>Save Field Mapping</span>
                </Button>
              </div>
            ) : (
              <p className="text-xs text-amber-400/80">Read-only mode (Admin role required to save mappings).</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
