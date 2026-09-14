import React from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Avatar } from '@/components/ui/Avatar';
import { MessageSquare, Send, Search, PhoneCall, Paperclip, CheckCheck } from 'lucide-react';

export default function MessagesPage() {
  const threads = [
    {
      id: 't1',
      name: 'John Doe (Acme Corp)',
      number: '+1 (555) 014-4321',
      lastMessage: 'Thanks for sending the updated quote!',
      time: '12m ago',
      unread: 2,
    },
    {
      id: 't2',
      name: 'Sarah Connor',
      number: '+1 (555) 019-8821',
      lastMessage: 'Can we schedule a callback at 3 PM?',
      time: '1h ago',
      unread: 0,
    },
  ];

  return (
    <div className="h-[calc(100vh-7rem)] flex flex-col md:flex-row gap-4">
      {/* Threads Sidebar */}
      <div className="w-full md:w-80 flex flex-col gap-3 bg-white dark:bg-slate-900/60 rounded-2xl border border-slate-200 dark:border-slate-800/80 p-4">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>Messages</span>
          </h2>
          <Badge variant="blue" size="sm">
            SMS
          </Badge>
        </div>
        <Input icon={<Search className="w-4 h-4" />} placeholder="Search messages..." />

        <div className="flex-1 overflow-y-auto space-y-2">
          {threads.map((thread) => (
            <div
              key={thread.id}
              className="p-3 rounded-xl bg-slate-50 hover:bg-slate-100 dark:bg-slate-950/60 dark:hover:bg-slate-800/60 border border-slate-200 dark:border-slate-800/80 cursor-pointer transition-all"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-900 dark:text-slate-200">{thread.name}</span>
                <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">{thread.time}</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-1">{thread.lastMessage}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Main Conversation Stream */}
      <div className="flex-1 flex flex-col bg-white dark:bg-slate-900/60 rounded-2xl border border-slate-200 dark:border-slate-800/80 overflow-hidden">
        {/* Chat Header */}
        <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-950/40">
          <div className="flex items-center gap-3">
            <Avatar name="John Doe" size="md" status="online" />
            <div>
              <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">John Doe (Acme Corp)</h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">+1 (555) 014-4321</p>
            </div>
          </div>
          <Button variant="outline" size="sm">
            <PhoneCall className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>Call Contact</span>
          </Button>
        </div>

        {/* Message Stream */}
        <div className="flex-1 p-4 overflow-y-auto space-y-3">
          <div className="flex flex-col items-start max-w-sm">
            <div className="p-3 rounded-2xl rounded-tl-xs bg-slate-100 dark:bg-slate-800 text-xs text-slate-900 dark:text-slate-200">
              Hi team, do you have an update on our account setup?
            </div>
            <span className="text-[9px] text-slate-500 mt-1 ml-1 font-mono">10:14 AM</span>
          </div>

          <div className="flex flex-col items-end max-w-sm ml-auto">
            <div className="p-3 rounded-2xl rounded-tr-xs bg-blue-600 text-xs text-white shadow-md shadow-blue-600/20">
              Hello John! Yes, your account setup is complete and ready.
            </div>
            <div className="flex items-center gap-1 mt-1 mr-1 text-[9px] text-slate-500 dark:text-slate-400 font-mono">
              <span>10:15 AM</span>
              <CheckCheck className="w-3 h-3 text-blue-600 dark:text-blue-400" />
            </div>
          </div>
        </div>

        {/* Message Input Bar */}
        <div className="p-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/80 flex items-center gap-2">
          <Input placeholder="Type SMS message..." className="flex-1" />
          <Button variant="primary" size="md">
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
