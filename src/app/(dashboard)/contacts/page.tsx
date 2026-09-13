'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Avatar } from '@/components/ui/Avatar';
import {
  Users,
  Search,
  Plus,
  PhoneCall,
  MessageSquare,
  Mail,
  Building,
  FileSpreadsheet,
  RefreshCw,
  UserCheck,
  MoreVertical,
  Eye,
  Edit,
  Trash2,
  Ban,
  AlertTriangle,
} from 'lucide-react';
import { Contact } from '@/lib/types';
import { AddContactModal } from '@/components/contacts/AddContactModal';
import { ImportContactsModal } from '@/components/contacts/ImportContactsModal';
import { ContactDetailsModal } from '@/components/contacts/ContactDetailsModal';
import { EditContactModal } from '@/components/contacts/EditContactModal';
import { DeleteContactConfirmationModal } from '@/components/contacts/DeleteContactConfirmationModal';
import { BlockContactConfirmationModal } from '@/components/contacts/BlockContactConfirmationModal';
import { useTwilioDeviceContext } from '@/components/providers/TwilioDeviceProvider';

export default function ContactsPage() {
  const router = useRouter();
  const { makeCall } = useTwilioDeviceContext();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Modals state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [selectedDetailsId, setSelectedDetailsId] = useState<string | null>(null);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [deletingContact, setDeletingContact] = useState<Contact | null>(null);
  const [blockingContact, setBlockingContact] = useState<Contact | null>(null);

  // Active 3-dot dropdown menu state
  const [activeMenuContactId, setActiveMenuContactId] = useState<string | null>(null);
  const [blockedAlertMessage, setBlockedAlertMessage] = useState<string | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);

  const fetchContacts = useCallback(async () => {
    setIsLoading(true);
    try {
      const url = searchQuery.trim()
        ? `/api/contacts?query=${encodeURIComponent(searchQuery.trim())}`
        : '/api/contacts';

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setContacts(data.contacts || []);
      }
    } catch (err) {
      console.error('Error fetching contacts:', err);
    } finally {
      setIsLoading(false);
    }
  }, [searchQuery]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  // Close dropdown menu on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenuContactId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCallContact = (contact: Contact) => {
    setBlockedAlertMessage(null);
    if (contact.is_blocked) {
      setBlockedAlertMessage(`This contact is blocked. Unblock the contact before calling.`);
      return;
    }
    makeCall(contact.phone, contact.full_name);
  };

  const handleMessageContact = (phoneNumber: string) => {
    if (!phoneNumber) return;
    router.push(`/messages?to=${encodeURIComponent(phoneNumber)}`);
  };

  const handleUnblockContact = async (contact: Contact) => {
    setActiveMenuContactId(null);
    setBlockedAlertMessage(null);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isBlocked: false }),
      });
      if (res.ok) {
        fetchContacts();
      }
    } catch (err) {
      console.error('Error unblocking contact:', err);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Header Banner */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-600/10 border border-blue-500/20 text-blue-400">
              <Users className="w-5 h-5" />
            </div>
            <span>Contacts Directory</span>
            <Badge variant="blue" size="md">
              {contacts.length} CONTACTS
            </Badge>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Internal team address book, client contact records, and PSTN directory.
          </p>
        </div>

        {/* Action Bar (Responsive) */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">
          <Input
            icon={<Search className="w-4 h-4" />}
            placeholder="Search contacts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full sm:w-64"
          />

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="md"
              onClick={() => setIsImportModalOpen(true)}
              className="flex-1 sm:flex-none whitespace-nowrap font-medium justify-center"
              title="Import Contacts from CSV file"
            >
              <FileSpreadsheet className="w-4 h-4 text-blue-400" />
              <span>Import</span>
            </Button>

            <Button
              variant="primary"
              size="md"
              onClick={() => setIsAddModalOpen(true)}
              className="flex-1 sm:flex-none whitespace-nowrap font-semibold shadow-lg shadow-blue-600/20 justify-center"
            >
              <Plus className="w-4 h-4" />
              <span>Add Contact</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Blocked Outbound Call Warning Banner */}
      {blockedAlertMessage && (
        <div className="p-3.5 rounded-xl bg-rose-950/80 border border-rose-700 text-rose-200 text-xs flex items-center justify-between animate-in fade-in">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4.5 h-4.5 text-rose-400 shrink-0" />
            <span className="font-medium">{blockedAlertMessage}</span>
          </div>
          <button
            onClick={() => setBlockedAlertMessage(null)}
            className="text-rose-400 hover:text-rose-200 ml-3"
          >
            ✕
          </button>
        </div>
      )}

      {/* Contacts Grid */}
      {isLoading ? (
        <Card className="p-12 text-center text-xs text-slate-500">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-3 text-blue-400" />
          <span>Loading contacts directory...</span>
        </Card>
      ) : contacts.length === 0 ? (
        <Card className="p-12 text-center text-xs text-slate-500 flex flex-col items-center justify-center gap-3">
          <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 text-slate-600">
            <Users className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-300">No Contacts Found</h3>
            {searchQuery ? (
              <p className="text-xs text-slate-500 mt-1">
                No contacts match your query "{searchQuery}".
              </p>
            ) : (
              <p className="text-xs text-slate-500 mt-1">
                Your directory is currently empty. Add your first contact manually or import a CSV list.
              </p>
            )}
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button variant="outline" size="sm" onClick={() => setIsImportModalOpen(true)}>
              <FileSpreadsheet className="w-3.5 h-3.5 text-blue-400" />
              <span>Import CSV</span>
            </Button>
            <Button variant="primary" size="sm" onClick={() => setIsAddModalOpen(true)}>
              <Plus className="w-3.5 h-3.5" />
              <span>Add Contact</span>
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {contacts.map((contact) => (
            <Card key={contact.id} hoverable className="flex flex-col justify-between space-y-4 relative">
              <div className="space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar name={contact.full_name || 'Contact'} size="lg" />
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold text-slate-100">{contact.full_name}</h3>
                        {contact.is_blocked && (
                          <Badge variant="rose" size="sm">
                            <Ban className="w-2.5 h-2.5" />
                            BLOCKED
                          </Badge>
                        )}
                      </div>
                      {contact.company ? (
                        <p className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
                          <Building className="w-3 h-3 text-slate-500 shrink-0" />
                          <span>{contact.company}</span>
                        </p>
                      ) : (
                        <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                          <UserCheck className="w-3 h-3 text-slate-500 shrink-0" />
                          <span>Direct Client</span>
                        </p>
                      )}
                    </div>
                  </div>

                  {/* 3-Dot Dropdown Actions Menu */}
                  <div className="relative" ref={activeMenuContactId === contact.id ? menuRef : null}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveMenuContactId(
                          activeMenuContactId === contact.id ? null : contact.id
                        );
                      }}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                      title="Contact Options"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>

                    {activeMenuContactId === contact.id && (
                      <div className="absolute right-0 top-8 z-30 w-44 rounded-xl bg-slate-900 border border-slate-800 shadow-2xl p-1.5 text-xs space-y-0.5 animate-in fade-in">
                        <button
                          onClick={() => {
                            setActiveMenuContactId(null);
                            setSelectedDetailsId(contact.id);
                          }}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                        >
                          <Eye className="w-3.5 h-3.5 text-blue-400" />
                          <span>View Details</span>
                        </button>

                        <button
                          onClick={() => {
                            setActiveMenuContactId(null);
                            setEditingContact(contact);
                          }}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                        >
                          <Edit className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Edit Contact</span>
                        </button>

                        {!contact.is_blocked && (
                          <>
                            <button
                              onClick={() => {
                                setActiveMenuContactId(null);
                                handleCallContact(contact);
                              }}
                              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                            >
                              <PhoneCall className="w-3.5 h-3.5 text-emerald-400" />
                              <span>Call</span>
                            </button>

                            <button
                              onClick={() => {
                                setActiveMenuContactId(null);
                                handleMessageContact(contact.phone);
                              }}
                              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-slate-100 hover:bg-slate-800 transition-colors"
                            >
                              <MessageSquare className="w-3.5 h-3.5 text-blue-400" />
                              <span>SMS Message</span>
                            </button>
                          </>
                        )}

                        <div className="h-px bg-slate-800 my-1" />

                        {contact.is_blocked ? (
                          <button
                            onClick={() => handleUnblockContact(contact)}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/60 transition-colors"
                          >
                            <Ban className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Unblock Contact</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              setActiveMenuContactId(null);
                              setBlockingContact(contact);
                            }}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-amber-400 hover:text-amber-300 hover:bg-amber-950/60 transition-colors"
                          >
                            <Ban className="w-3.5 h-3.5 text-amber-400" />
                            <span>Block Contact</span>
                          </button>
                        )}

                        <button
                          onClick={() => {
                            setActiveMenuContactId(null);
                            setDeletingContact(contact);
                          }}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-rose-400 hover:text-rose-200 hover:bg-rose-950/60 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                          <span>Delete Contact</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5 pt-2 border-t border-slate-800 text-xs">
                  <p className="text-slate-300 font-mono flex items-center gap-2">
                    <PhoneCall className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                    <span>{contact.phone}</span>
                  </p>
                  {contact.email && (
                    <p className="text-slate-400 flex items-center gap-2 truncate">
                      <Mail className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="truncate">{contact.email}</span>
                    </p>
                  )}
                </div>

                {contact.notes && (
                  <p className="text-[11px] text-slate-400 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80 line-clamp-2">
                    {contact.notes}
                  </p>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 pt-3 border-t border-slate-800">
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full font-medium"
                  onClick={() => handleCallContact(contact)}
                >
                  <PhoneCall className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Call</span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full font-medium"
                  onClick={() => handleMessageContact(contact.phone)}
                >
                  <MessageSquare className="w-3.5 h-3.5 text-blue-400" />
                  <span>Message</span>
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Modals */}
      <AddContactModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSuccess={fetchContacts}
      />

      <ImportContactsModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onSuccess={fetchContacts}
      />

      <ContactDetailsModal
        contactId={selectedDetailsId}
        isOpen={Boolean(selectedDetailsId)}
        onClose={() => setSelectedDetailsId(null)}
        onEdit={(contactToEdit) => setEditingContact(contactToEdit)}
        onDelete={(contactToDelete) => setDeletingContact(contactToDelete)}
        onCall={(phoneNum, isBlocked, contactName) => {
          if (isBlocked) {
            setBlockedAlertMessage(`This contact is blocked. Unblock the contact before calling.`);
            return;
          }
          makeCall(phoneNum, contactName);
        }}
        onMessage={(phoneNum) => handleMessageContact(phoneNum)}
        onStatusChange={fetchContacts}
      />

      <EditContactModal
        contact={editingContact}
        isOpen={Boolean(editingContact)}
        onClose={() => setEditingContact(null)}
        onSuccess={fetchContacts}
      />

      <DeleteContactConfirmationModal
        contact={deletingContact}
        isOpen={Boolean(deletingContact)}
        onClose={() => setDeletingContact(null)}
        onSuccess={fetchContacts}
      />

      <BlockContactConfirmationModal
        contact={blockingContact}
        isOpen={Boolean(blockingContact)}
        onClose={() => setBlockingContact(null)}
        onSuccess={fetchContacts}
      />
    </div>
  );
}
