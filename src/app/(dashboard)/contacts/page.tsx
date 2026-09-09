import React from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Avatar } from '@/components/ui/Avatar';
import { Users, Search, Plus, PhoneCall, MessageSquare, Mail, Building } from 'lucide-react';

export default function ContactsPage() {
  const contacts = [
    {
      id: 'c1',
      name: 'John Doe',
      company: 'Acme Corporation',
      phone: '+1 (555) 014-4321',
      email: 'john.doe@acme.example',
      notes: 'Key decision maker for enterprise telecom account.',
    },
    {
      id: 'c2',
      name: 'Sarah Connor',
      company: 'Cyberdyne Systems',
      phone: '+1 (555) 019-8821',
      email: 'sconnor@cyberdyne.example',
      notes: 'Requested callback regarding Twilio numbers.',
    },
    {
      id: 'c3',
      name: 'Michael Scott',
      company: 'Dunder Mifflin Paper Co.',
      phone: '+1 (555) 012-9900',
      email: 'mscott@dundermifflin.example',
      notes: 'Prefers SMS communications over phone calls.',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>Contacts Directory</span>
            <Badge variant="blue" size="md">
              3 CONTACTS
            </Badge>
          </h1>
          <p className="text-xs text-slate-400">Internal address book and client contact records.</p>
        </div>
        <div className="flex items-center gap-3">
          <Input icon={<Search className="w-4 h-4" />} placeholder="Search contacts..." className="w-64" />
          <Button variant="primary" size="md">
            <Plus className="w-4 h-4" />
            <span>Add Contact</span>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {contacts.map((contact) => (
          <Card key={contact.id} hoverable className="flex flex-col justify-between space-y-4">
            <div className="space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <Avatar name={contact.name} size="lg" />
                  <div>
                    <h3 className="text-sm font-bold text-slate-100">{contact.name}</h3>
                    <p className="text-xs text-slate-400 flex items-center gap-1">
                      <Building className="w-3 h-3 text-slate-500" />
                      <span>{contact.company}</span>
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5 pt-2 border-t border-slate-800 text-xs">
                <p className="text-slate-300 font-mono flex items-center gap-2">
                  <PhoneCall className="w-3.5 h-3.5 text-blue-400" />
                  <span>{contact.phone}</span>
                </p>
                <p className="text-slate-400 flex items-center gap-2">
                  <Mail className="w-3.5 h-3.5 text-slate-500" />
                  <span>{contact.email}</span>
                </p>
              </div>

              {contact.notes && (
                <p className="text-[11px] text-slate-500 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
                  {contact.notes}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 pt-3 border-t border-slate-800">
              <Button variant="secondary" size="sm" className="w-full">
                <PhoneCall className="w-3.5 h-3.5 text-emerald-400" />
                <span>Call</span>
              </Button>
              <Button variant="secondary" size="sm" className="w-full">
                <MessageSquare className="w-3.5 h-3.5 text-blue-400" />
                <span>Message</span>
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
