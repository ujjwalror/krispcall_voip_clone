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

  // CRM Record Attribution State
  const [attrTargetKey, setAttrTargetKey] = useState<string>('');
  const [attrValue, setAttrValue] = useState<string>('');
  const [isSavingAttr, setIsSavingAttr] = useState(false);

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

      // 3. Fetch CRM Record Attribution rule
      const attrRes = await fetch(
        `/api/integrations/crm/attribution?provider=${provider}&module=${activeModule}`
      );
      const attrData = await attrRes.json();
      if (attrRes.ok && Array.isArray(attrData.rules) && attrData.rules.length > 0) {
        const rule = attrData.rules[0];
        setAttrTargetKey(rule.externalFieldKey || '');
        setAttrValue(rule.configuredValue || '');
      } else {
        setAttrTargetKey('');
        setAttrValue('');
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

  const handleSaveAttribution = async () => {
    if (!isAdmin) return;
    const targetKeyToSave = effectiveTargetKey;
    if (!targetKeyToSave) {
      setError('No target Lead Source field is configured.');
      return;
    }

    setIsSavingAttr(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/integrations/crm/attribution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          externalModule: activeModule,
          attributeKey: 'lead_source',
          externalFieldKey: targetKeyToSave,
          configuredValue: attrValue,
          isEnabled: Boolean(targetKeyToSave && attrValue),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save Lead Creation Settings');
      }

      setAttrTargetKey(targetKeyToSave);
      setSuccessMsg(`${activeModule === 'Leads' ? 'Lead' : 'Contact'} Creation Settings saved successfully.`);
    } catch (err: any) {
      setError(err.message || 'Error saving Lead Creation Settings');
    } finally {
      setIsSavingAttr(false);
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

  const discoveredSourceField =
    fields.find((f) => f.isSourceField && f.isWritable) ||
    fields.find(
      (f) =>
        f.isWritable &&
        (f.fieldKey === 'Lead_Source' ||
          f.fieldKey.toLowerCase() === 'lead_source' ||
          f.label.toLowerCase() === 'lead source')
    );

  const effectiveTargetKey = attrTargetKey || discoveredSourceField?.fieldKey || '';
  const selectedAttrMetadata = fields.find((f) => f.fieldKey === effectiveTargetKey);
  const isAttrPicklist = selectedAttrMetadata?.dataType === 'picklist';
  const hasVoipHubOption =
    isAttrPicklist &&
    Array.isArray(selectedAttrMetadata?.options) &&
    selectedAttrMetadata.options.some((opt) => opt.value === 'VoIP Hub' || opt.label === 'VoIP Hub');

  const isSavedValueMissing =
    isAttrPicklist &&
    Boolean(attrValue) &&
    Array.isArray(selectedAttrMetadata?.options) &&
    !selectedAttrMetadata.options.some((opt) => opt.value === attrValue || opt.label === attrValue);

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
            className="text-xs border-slate-800 bg-slate-950 text-slate-300 hover:bg-slate-800"
            title="Re-fetch field metadata snapshot from Zoho CRM"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span>Refresh CRM Fields</span>
          </Button>
        </div>
      </div>

      {/* Module Selector (Leads vs Contacts) */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
        <button
          onClick={() => setActiveModule('Leads')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            activeModule === 'Leads'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          Leads Module
        </button>
        <button
          onClick={() => setActiveModule('Contacts')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            activeModule === 'Contacts'
              ? 'bg-blue-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
        >
          Contacts Module (Prepared)
        </button>
      </div>

      {/* Error / Success Banners */}
      {error && (
        <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-3.5 rounded-xl bg-emerald-950/60 border border-emerald-800 text-emerald-200 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Main Mapping Area */}
      {isLoading ? (
        <div className="p-12 text-center text-slate-400 space-y-3 bg-slate-900/60 rounded-xl border border-slate-800">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-400" />
          <p className="text-xs">Loading {provider.toUpperCase()} module metadata and field mappings...</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Mappings Table / List */}
          <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-900/60">
            <div className="p-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs font-semibold text-slate-300">
              <div className="w-1/3">VoIP Hub Field</div>
              <div className="w-8 text-center text-slate-500">→</div>
              <div className="w-2/3">{provider.toUpperCase()} {activeModule} Field</div>
            </div>

            <div className="divide-y divide-slate-800/60">
              {LOCAL_VOIP_HUB_FIELDS.map((local) => {
                const selectedExtKey = mappings[local.key] || '';
                const selectedMetadata = fields.find((f) => f.fieldKey === selectedExtKey);

                return (
                  <div
                    key={local.key}
                    className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs hover:bg-slate-900/40 transition-colors"
                  >
                    <div className="w-full sm:w-1/3 space-y-0.5">
                      <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                        <span>{local.label}</span>
                      </div>
                      <p className="text-[11px] text-slate-400 font-mono">key: {local.key} ({local.dataType})</p>
                    </div>

                    <div className="hidden sm:block text-slate-600 font-bold">→</div>

                    <div className="w-full sm:w-2/3 space-y-1">
                      <select
                        value={selectedExtKey}
                        disabled={!isAdmin}
                        onChange={(e) => handleFieldSelect(local.key, e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500 disabled:opacity-60"
                      >
                        <option value="">-- Do Not Map --</option>
                        {fields.map((field) => {
                          const isCompatible = isFieldMappingCompatible(local.dataType, field);
                          if (!isCompatible && field.fieldKey !== selectedExtKey) {
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

          {/* Lead Creation Settings Section */}
          <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-900/60 p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <div>
                <h4 className="text-xs font-bold text-slate-200 flex items-center gap-2">
                  <span>{activeModule === 'Leads' ? 'Lead Creation Settings' : 'Contact Creation Settings'}</span>
                </h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Choose the source assigned to Leads created by VoIP Hub.
                </p>
              </div>
            </div>

            {/* Standard Discovered Source Field View */}
            {discoveredSourceField ? (
              <div className="max-w-md space-y-1.5 text-xs">
                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  Lead Source
                </label>
                {isAttrPicklist && Array.isArray(selectedAttrMetadata?.options) ? (
                  <select
                    value={attrValue}
                    disabled={!isAdmin}
                    onChange={(e) => setAttrValue(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500 disabled:opacity-60"
                  >
                    <option value="">Select a Lead Source</option>
                    {selectedAttrMetadata.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label} ({opt.value})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={attrValue}
                    disabled={!isAdmin}
                    onChange={(e) => setAttrValue(e.target.value)}
                    placeholder="e.g. VoIP Hub"
                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500 disabled:opacity-60"
                  />
                )}
              </div>
            ) : (
              /* Fallback Advanced Field Selector for CRM providers without a discoverable source field */
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    {activeModule === 'Leads' ? 'Lead Source Field' : 'Contact Source Field'}
                  </label>
                  <select
                    value={attrTargetKey}
                    disabled={!isAdmin}
                    onChange={(e) => {
                      const key = e.target.value;
                      setAttrTargetKey(key);
                      const meta = fields.find((f) => f.fieldKey === key);
                      if (meta?.dataType === 'picklist' && Array.isArray(meta.options)) {
                        const isValid = meta.options.some((o) => o.value === attrValue || o.label === attrValue);
                        if (!isValid) setAttrValue('');
                      } else if (!meta) {
                        setAttrValue('');
                      }
                    }}
                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500 disabled:opacity-60"
                  >
                    <option value="">-- No Source Field Selected --</option>
                    {fields
                      .filter((f) => f.isWritable && (f.dataType === 'text' || f.dataType === 'picklist'))
                      .map((field) => (
                        <option key={field.fieldKey} value={field.fieldKey}>
                          {field.label} ({field.fieldKey}) [{field.dataType}]
                        </option>
                      ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    {activeModule === 'Leads' ? 'Lead Source Value' : 'Contact Source Value'}
                  </label>
                  {isAttrPicklist && Array.isArray(selectedAttrMetadata?.options) ? (
                    <select
                      value={attrValue}
                      disabled={!isAdmin || !effectiveTargetKey}
                      onChange={(e) => setAttrValue(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500 disabled:opacity-60"
                    >
                      <option value="">Select a value</option>
                      {selectedAttrMetadata.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label} ({opt.value})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={attrValue}
                      disabled={!isAdmin || !effectiveTargetKey}
                      onChange={(e) => setAttrValue(e.target.value)}
                      placeholder="e.g. VoIP Hub"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500 disabled:opacity-60"
                    />
                  )}
                </div>
              </div>
            )}

            {/* Informational Banner if "VoIP Hub" is not present in CRM picklist options */}
            {isAttrPicklist && !hasVoipHubOption && (
              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 text-[11px] flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-slate-200">
                    "VoIP Hub" is not currently available as a Lead Source in your CRM.
                  </span>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    Add "VoIP Hub" to your {provider.toUpperCase()} {activeModule} picklist options in CRM settings, then click <span className="font-semibold text-slate-300">Refresh CRM Fields</span> above to select it.
                  </p>
                </div>
              </div>
            )}

            {/* Warning if a previously saved picklist value no longer exists in CRM metadata */}
            {isSavedValueMissing && (
              <div className="p-3 rounded-lg bg-amber-950/60 border border-amber-800 text-amber-200 text-[11px] flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">This saved Lead Source is no longer available in your CRM. Select another value.</span>
                </div>
              </div>
            )}

            {isAdmin && (
              <div className="flex justify-end pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSaveAttribution}
                  disabled={isSavingAttr}
                  className="text-xs border-slate-700 text-slate-300 hover:bg-slate-800"
                >
                  {isSavingAttr ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  <span>Save</span>
                </Button>
              </div>
            )}
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
