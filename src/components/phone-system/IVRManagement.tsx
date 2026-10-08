'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  PhoneCall,
  Sliders,
  Plus,
  Trash2,
  Edit2,
  Clock,
  Volume2,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Phone,
  Shield,
  Layers,
  Bot,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';

export interface IvrMenuUI {
  id: string;
  name: string;
  enabled: boolean;
  greetingType: 'tts' | 'audio_url';
  greetingText: string;
  timeoutSeconds: number;
  maxRetries: number;
  timeoutDestinationType: string;
  fallbackDestinationType: string;
  options?: {
    id: string;
    digit: string;
    destinationType: string;
    destinationId: string | null;
    enabled: boolean;
  }[];
}

export function IVRManagement() {
  const { profile } = useAuth();
  const [menus, setMenus] = useState<IvrMenuUI[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [selectedMenu, setSelectedMenu] = useState<IvrMenuUI | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // New Menu Form State
  const [newMenuName, setNewMenuName] = useState<string>('');
  const [newGreetingText, setNewGreetingText] = useState<string>(
    'Thank you for calling. Press 1 to speak with sales, or press 2 for support.'
  );
  const [newTimeoutSeconds, setNewTimeoutSeconds] = useState<number>(5);
  const [newMaxRetries, setNewMaxRetries] = useState<number>(3);

  // New Option Form State
  const [newDigit, setNewDigit] = useState<string>('1');
  const [newDestType, setNewDestType] = useState<string>('user');
  const [isAddingOption, setIsAddingOption] = useState<boolean>(false);

  const fetchMenus = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ivr', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setMenus(data.menus || []);
      } else {
        const errJson = await res.json().catch(() => ({}));
        setError(errJson.message || 'Failed to load IVR menus.');
      }
    } catch (err) {
      setError('Network error loading IVR menus.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMenus();
  }, [fetchMenus]);

  const handleCreateMenu = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!newMenuName.trim()) {
      setError('IVR menu name is required.');
      return;
    }

    try {
      const res = await fetch('/api/ivr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newMenuName.trim(),
          greetingText: newGreetingText.trim(),
          timeoutSeconds: newTimeoutSeconds,
          maxRetries: newMaxRetries,
        }),
      });

      const data = await res.json();
      if (res.ok && data.result?.success) {
        setSuccess('IVR menu created successfully!');
        setNewMenuName('');
        setIsCreating(false);
        fetchMenus();
      } else {
        setError(data.message || 'Failed to create IVR menu.');
      }
    } catch (err) {
      setError('Network error creating IVR menu.');
    }
  };

  const handleAddOption = async (menuId: string) => {
    setError(null);
    setSuccess(null);

    if (newDestType === 'call_queue') {
      setError('Call Queues are under development and will be available in Phase 19B.');
      return;
    }

    try {
      const res = await fetch(`/api/ivr/${menuId}/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          digit: newDigit,
          destinationType: newDestType,
        }),
      });

      const data = await res.json();
      if (res.ok && data.result?.success) {
        setSuccess(`Digit '${newDigit}' option added!`);
        setIsAddingOption(false);
        fetchMenus();
      } else {
        setError(data.message || 'Failed to add option.');
      }
    } catch (err) {
      setError('Network error adding option.');
    }
  };

  const handleDeleteOption = async (menuId: string, optionId: string) => {
    try {
      const res = await fetch(`/api/ivr/${menuId}/options/${optionId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setSuccess('Option removed.');
        fetchMenus();
      }
    } catch (err) {
      setError('Failed to delete option.');
    }
  };

  const handleDeleteMenu = async (menuId: string) => {
    if (!confirm('Are you sure you want to disable this IVR menu?')) return;
    try {
      const res = await fetch(`/api/ivr/${menuId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setSuccess('IVR menu disabled.');
        fetchMenus();
      }
    } catch (err) {
      setError('Failed to disable menu.');
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-16">
      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Bot className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>Interactive Voice Response (IVR)</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Configure automated auto-attendant menus, DTMF keypad options, and inbound routing.
          </p>
        </div>

        <Button
          onClick={() => setIsCreating(true)}
          variant="primary"
          className="text-xs flex items-center gap-1.5 shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>Create IVR Menu</span>
        </Button>
      </div>

      {/* NOTIFICATIONS */}
      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-900 dark:text-rose-200 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-900 dark:text-emerald-200 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {/* CREATE NEW MENU MODAL */}
      {isCreating && (
        <Card className="border-blue-500/30 bg-blue-50/10 dark:bg-blue-950/10">
          <CardHeader>
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Sliders className="w-4 h-4 text-blue-500" />
              <span>Create New IVR Auto-Attendant Menu</span>
            </CardTitle>
          </CardHeader>
          <form onSubmit={handleCreateMenu} className="p-5 pt-0 space-y-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Menu Name
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Main Company Directory"
                value={newMenuName}
                onChange={(e) => setNewMenuName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Greeting Prompt (Text-to-Speech)
              </label>
              <textarea
                rows={3}
                required
                value={newGreetingText}
                onChange={(e) => setNewGreetingText(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Input Timeout (seconds)
                </label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={newTimeoutSeconds}
                  onChange={(e) => setNewTimeoutSeconds(parseInt(e.target.value, 10))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Maximum Invalid Retries
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={newMaxRetries}
                  onChange={(e) => setNewMaxRetries(parseInt(e.target.value, 10))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setIsCreating(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" type="submit">
                Save IVR Menu
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* LOADING STATE */}
      {isLoading ? (
        <div className="py-20 flex flex-col items-center justify-center space-y-3">
          <Loader2 className="w-7 h-7 text-blue-500 animate-spin" />
          <p className="text-xs text-slate-500">Loading IVR menus...</p>
        </div>
      ) : menus.length === 0 ? (
        /* EMPTY STATE */
        <Card className="py-12 text-center space-y-3">
          <div className="w-12 h-12 mx-auto rounded-full bg-blue-500/10 text-blue-500 flex items-center justify-center">
            <Bot className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">No IVR Menus Configured</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
              Create an automated auto-attendant menu to greet inbound callers and route them based on DTMF keypresses.
            </p>
          </div>
          <Button onClick={() => setIsCreating(true)} variant="primary" size="sm" className="mt-2">
            <Plus className="w-4 h-4 mr-1" />
            Create First IVR Menu
          </Button>
        </Card>
      ) : (
        /* MENUS LIST & OPTION NODES */
        <div className="space-y-6">
          {menus.map((menu) => (
            <Card key={menu.id} className="border-slate-200 dark:border-slate-800">
              <CardHeader className="border-b border-slate-100 dark:border-slate-800/80 pb-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/15 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold text-xs">
                      <Bot className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                        <span>{menu.name}</span>
                        {menu.enabled ? (
                          <Badge variant="emerald" className="text-[10px]">Active</Badge>
                        ) : (
                          <Badge variant="neutral" className="text-[10px]">Disabled</Badge>
                        )}
                      </h3>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        Timeout: {menu.timeoutSeconds}s | Max Retries: {menu.maxRetries}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      onClick={() => {
                        setSelectedMenu(menu);
                        setIsAddingOption(true);
                      }}
                      variant="outline"
                      size="sm"
                      className="text-xs"
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      Add Keypress Option
                    </Button>
                    <Button
                      onClick={() => handleDeleteMenu(menu.id)}
                      variant="outline"
                      size="sm"
                      className="text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>

              <div className="p-4 space-y-4 text-xs">
                {/* Greeting Preview */}
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-start gap-2.5">
                  <Volume2 className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-slate-700 dark:text-slate-300 text-[11px]">Greeting Prompt:</div>
                    <p className="text-slate-600 dark:text-slate-400 italic text-[11px] mt-0.5">
                      &quot;{menu.greetingText}&quot;
                    </p>
                  </div>
                </div>

                {/* DTMF Keypress Options Table */}
                <div>
                  <div className="font-bold text-slate-900 dark:text-slate-100 mb-2 flex items-center justify-between">
                    <span>DTMF Keypad Selections</span>
                    <span className="text-[11px] text-slate-500 font-normal">
                      {menu.options?.length || 0} active options
                    </span>
                  </div>

                  {!menu.options || menu.options.length === 0 ? (
                    <div className="p-4 text-center text-[11px] text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
                      No keypress options configured for this menu yet. Click &quot;Add Keypress Option&quot; above.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                      {menu.options.map((opt) => (
                        <div key={opt.id} className="p-3 flex items-center justify-between bg-white dark:bg-slate-900">
                          <div className="flex items-center gap-3">
                            <span className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center font-mono font-bold text-slate-900 dark:text-slate-100 text-xs border border-slate-200 dark:border-slate-700">
                              {opt.digit}
                            </span>
                            <div>
                              <div className="font-semibold text-slate-800 dark:text-slate-200 capitalize">
                                Route to {opt.destinationType.replace('_', ' ')}
                              </div>
                              <div className="text-[10px] text-slate-400">
                                {opt.destinationType === 'call_queue' ? (
                                  <span className="text-amber-500 font-medium">In Development (Phase 19B)</span>
                                ) : (
                                  `Target: ${opt.destinationId || 'Main extension'}`
                                )}
                              </div>
                            </div>
                          </div>

                          <button
                            onClick={() => handleDeleteOption(menu.id, opt.id)}
                            className="p-1.5 text-slate-400 hover:text-rose-500 rounded-md"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ADD OPTION FORM MODAL FOR SELECTED MENU */}
                {isAddingOption && selectedMenu?.id === menu.id && (
                  <div className="p-4 rounded-xl border border-blue-500/30 bg-blue-50/20 dark:bg-blue-950/20 space-y-3">
                    <div className="font-bold text-slate-900 dark:text-slate-100">Add Keypress Option</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                          Keypad Digit
                        </label>
                        <select
                          value={newDigit}
                          onChange={(e) => setNewDigit(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                        >
                          {['0','1','2','3','4','5','6','7','8','9','*','#'].map((d) => (
                            <option key={d} value={d}>Key &quot;{d}&quot;</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300 mb-1">
                          Routing Destination Type
                        </label>
                        <select
                          value={newDestType}
                          onChange={(e) => setNewDestType(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                        >
                          <option value="user">User / Extension</option>
                          <option value="ivr">Nested IVR Menu</option>
                          <option value="voicemail">Voicemail</option>
                          <option value="call_queue">Call Queue (In Development)</option>
                          <option value="hangup">Hangup Call</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                      <Button variant="outline" size="sm" onClick={() => setIsAddingOption(false)}>
                        Cancel
                      </Button>
                      <Button variant="primary" size="sm" onClick={() => handleAddOption(menu.id)}>
                        Add Option
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
