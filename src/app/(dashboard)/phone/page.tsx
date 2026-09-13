import React from 'react';
import { DialerWidget } from '@/components/dialer/DialerWidget';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PhoneCall, Mic, Volume2, Settings, History, Shield, Globe } from 'lucide-react';

export default function PhonePage() {
  const recentDials = [
    { name: 'John Doe', company: 'Acme Corp', number: '+1 (555) 014-4321', time: '10 mins ago' },
    { name: 'Sarah Connor', company: 'Cyberdyne', number: '+1 (555) 019-8821', time: '1 hour ago' },
    { name: 'Michael Scott', company: 'Dunder Mifflin', number: '+1 (555) 012-9900', time: 'Yesterday' },
  ];

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Browser WebRTC Dialer</h1>
          <p className="text-xs text-slate-400">Make and receive business calls directly from your browser.</p>
        </div>
        <Badge variant="emerald" pulse size="md">
          <Shield className="w-3 h-3" />
          Voice Line Connected
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
        {/* Dialer Panel */}
        <div>
          <DialerWidget />
        </div>

        {/* Call Configuration & Quick Contacts */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Settings className="w-4 h-4 text-blue-400" />
                <span>Audio Device Settings</span>
              </CardTitle>
            </CardHeader>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 font-medium block mb-1.5">Microphone Device</label>
                <select className="w-full bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 p-2.5 outline-none focus:border-blue-500">
                  <option>Default - MacBook Pro Microphone (Built-in)</option>
                  <option>External USB Headset Microphone</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 font-medium block mb-1.5">Speaker / Headset Output</label>
                <select className="w-full bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 p-2.5 outline-none focus:border-blue-500">
                  <option>Default - MacBook Pro Speakers (Built-in)</option>
                  <option>External Headphones Output</option>
                </select>
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                <span className="text-xs text-slate-400">Ringtone Volume</span>
                <span className="text-xs font-mono text-blue-400 font-semibold">80%</span>
              </div>
            </div>
          </Card>

          {/* Quick Redial List */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <History className="w-4 h-4 text-indigo-400" />
                <span>Quick Redial</span>
              </CardTitle>
            </CardHeader>
            <div className="space-y-2">
              {recentDials.map((contact) => (
                <div
                  key={contact.number}
                  className="flex items-center justify-between p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 hover:border-slate-700 transition-colors"
                >
                  <div>
                    <p className="text-xs font-semibold text-slate-200">{contact.name}</p>
                    <p className="text-[10px] text-slate-400">{contact.company} • {contact.number}</p>
                  </div>
                  <Button variant="ghost" size="sm" className="text-blue-400 hover:text-blue-300">
                    <PhoneCall className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
