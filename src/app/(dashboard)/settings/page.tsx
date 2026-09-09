import React from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Settings, Volume2, Mic, Bell, Shield, Radio } from 'lucide-react';

export default function SettingsPage() {
  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-xl font-bold text-slate-100">Agent & Telecom Settings</h1>
        <p className="text-xs text-slate-400">Configure WebRTC audio devices, notifications, and workplace preferences.</p>
      </div>

      <div className="space-y-6">
        {/* WebRTC Audio Preferences */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Mic className="w-4 h-4 text-blue-400" />
              <span>WebRTC Audio Devices</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5">Microphone Device</label>
                <select className="w-full bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 p-2.5 outline-none focus:border-blue-500">
                  <option>MacBook Pro Microphone (Built-in)</option>
                  <option>External USB Headset Microphone</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1.5">Speaker / Headset Output</label>
                <select className="w-full bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 p-2.5 outline-none focus:border-blue-500">
                  <option>MacBook Pro Speakers (Built-in)</option>
                  <option>External Headphones Output</option>
                </select>
              </div>
            </div>
          </div>
        </Card>

        {/* Ringtone & Notification Alert Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Bell className="w-4 h-4 text-amber-400" />
              <span>Inbound Ringtone & Call Alerts</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-950/60 border border-slate-800">
              <div>
                <p className="text-xs font-semibold text-slate-200">Play Ringtone for Incoming Calls</p>
                <p className="text-[10px] text-slate-400">Audible alert when an incoming PSTN call is routed to your agent identity.</p>
              </div>
              <input type="checkbox" defaultChecked className="w-4 h-4 accent-blue-600 rounded" />
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
