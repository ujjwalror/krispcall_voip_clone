'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { X, Edit3, PhoneCall, Mail, Building, FileText, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { Contact } from '@/lib/types';
import { normalizeE164PhoneNumber } from '@/lib/utils';

interface EditContactModalProps {
  contact: Contact | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  members?: { id: string; full_name: string; role: string; active?: boolean }[];
  currentUserRole?: string;
}

export function EditContactModal({ contact, isOpen, onClose, onSuccess, members = [], currentUserRole = 'agent' }: EditContactModalProps) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [notes, setNotes] = useState('');
  const [assignedUserId, setAssignedUserId] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const eligibleMembers = members.filter(
    (m) => m.active !== false && ['manager', 'agent'].includes(m.role)
  );

  const canAssign = ['admin', 'manager'].includes(currentUserRole);

  useEffect(() => {
    if (contact) {
      setFirstName(contact.first_name || '');
      setLastName(contact.last_name || '');
      setPhone(contact.phone || '');
      setEmail(contact.email || '');
      setCompany(contact.company || '');
      setNotes(contact.notes || '');
      setAssignedUserId((contact as any).assigned_user_id || (contact as any).assigned_user?.id || '');
      setErrorMessage(null);
      setSuccessMessage(null);
    }
  }, [contact]);

  if (!isOpen || !contact) return null;

  const handleClose = () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!phone.trim()) {
      setErrorMessage('Phone number is required.');
      return;
    }

    const phoneVal = normalizeE164PhoneNumber(phone.trim());
    if (!phoneVal.isValid) {
      setErrorMessage(phoneVal.error || 'Please enter a valid phone number (e.g. +61412345678).');
      return;
    }

    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim(),
          email: email.trim(),
          company: company.trim(),
          notes: notes.trim(),
          assigned_user_id: assignedUserId || null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to update contact.');
        return;
      }

      setSuccessMessage('Contact updated successfully!');
      onSuccess();
      setTimeout(() => {
        handleClose();
      }, 1000);
    } catch (err: any) {
      console.error('Error updating contact:', err);
      setErrorMessage('Network error while updating contact.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
      <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-600/10 border border-blue-500/20 text-blue-400">
              <Edit3 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">Edit Contact</h2>
              <p className="text-xs text-slate-400">Update contact details for {contact.full_name}.</p>
            </div>
          </div>

          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 flex-1">
          {errorMessage && (
            <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-800 text-emerald-200 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{successMessage}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">First Name</label>
              <Input
                type="text"
                placeholder="First Name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">Last Name</label>
              <Input
                type="text"
                placeholder="Last Name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">
              Phone Number <span className="text-rose-400">*</span>
            </label>
            <Input
              type="text"
              icon={<PhoneCall className="w-4 h-4" />}
              placeholder="e.g. +61412345678"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">Email Address</label>
              <Input
                type="email"
                icon={<Mail className="w-4 h-4" />}
                placeholder="email@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1">Company / Org</label>
              <Input
                type="text"
                icon={<Building className="w-4 h-4" />}
                placeholder="Company Name"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">Assigned Agent</label>
            <select
              value={assignedUserId}
              onChange={(e) => setAssignedUserId(e.target.value)}
              disabled={!canAssign || isSubmitting}
              className="w-full bg-slate-950/80 text-slate-100 text-xs rounded-lg border border-slate-800 p-2.5 outline-none focus:border-blue-500 transition-colors disabled:opacity-50"
            >
              <option value="">Unassigned (No Preferred Agent)</option>
              {eligibleMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.full_name} ({member.role})
                </option>
              ))}
            </select>
            {!canAssign && (
              <p className="text-[10px] text-slate-500 mt-1">Only Admins and Managers can assign contacts to team members.</p>
            )}
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-300 block mb-1">Notes / Remarks</label>
            <textarea
              rows={3}
              placeholder="Add key account info, preference notes..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-slate-950/80 text-slate-100 text-xs placeholder-slate-500 rounded-lg border border-slate-800 p-3 outline-none focus:border-blue-500 transition-colors resize-none"
            />
          </div>

          {/* Modal Footer */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
            <Button type="button" variant="outline" size="md" onClick={handleClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <span>Save Changes</span>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
