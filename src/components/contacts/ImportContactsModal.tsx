'use client';

import React, { useState, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  X,
  UploadCloud,
  FileSpreadsheet,
  Download,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  FileText,
  Users,
  Info,
} from 'lucide-react';
import { parseCsvText, generateContactsCsvTemplate, ParsedCsvRow } from '@/lib/csv';
import { normalizeE164PhoneNumber } from '@/lib/utils';

interface ImportContactsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface RowValidationResult {
  rowNumber: number;
  data: Record<string, string>;
  isValid: boolean;
  isDuplicate: boolean;
  errorReason?: string;
}

export function ImportContactsModal({ isOpen, onClose, onSuccess }: ImportContactsModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const [validatedRows, setValidatedRows] = useState<RowValidationResult[]>([]);
  const [readyCount, setReadyCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [invalidCount, setInvalidCount] = useState(0);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const resetModal = () => {
    setFile(null);
    setIsDragOver(false);
    setIsParsing(false);
    setIsImporting(false);
    setValidatedRows([]);
    setReadyCount(0);
    setDuplicateCount(0);
    setInvalidCount(0);
    setGeneralError(null);
    setImportSummary(null);
  };

  const handleClose = () => {
    resetModal();
    onClose();
  };

  // Download CSV Template helper
  const handleDownloadTemplate = () => {
    const csvContent = generateContactsCsvTemplate();
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'contacts_template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Parse and validate selected CSV file
  const processCsvFile = async (selectedFile: File) => {
    if (!selectedFile.name.endsWith('.csv') && selectedFile.type !== 'text/csv') {
      setGeneralError('Invalid file type. Please select a valid .csv file.');
      return;
    }

    setFile(selectedFile);
    setIsParsing(true);
    setGeneralError(null);

    try {
      // 1. Fetch current organization contacts to detect duplicates
      const existingRes = await fetch('/api/contacts');
      const existingData = await existingRes.json();
      const existingContacts: any[] = existingData.contacts || [];

      const existingPhoneSet = new Set<string>();
      existingContacts.forEach((c) => {
        if (c.phone) {
          existingPhoneSet.add(c.phone.trim());
        }
      });

      // 2. Read file content
      const csvText = await selectedFile.text();
      const parseResult = parseCsvText(csvText);

      if (parseResult.errors.length > 0) {
        setGeneralError(parseResult.errors.join(' '));
        setIsParsing(false);
        return;
      }

      if (parseResult.rows.length === 0) {
        setGeneralError('The selected CSV file contains no data rows.');
        setIsParsing(false);
        return;
      }

      if (parseResult.rows.length > 500) {
        setGeneralError('CSV exceeds maximum limit of 500 rows. Please split your file into smaller batches.');
        setIsParsing(false);
        return;
      }

      // 3. Validate each row
      const results: RowValidationResult[] = [];
      let ready = 0;
      let dupes = 0;
      let invalids = 0;
      const seenBatchPhoneSet = new Set<string>();

      for (const r of parseResult.rows) {
        const d = r.data;
        const rawPhone = (d.phone || '').trim();
        const email = (d.email || '').trim();

        if (!rawPhone) {
          invalids++;
          results.push({
            rowNumber: r.rowNumber,
            data: d,
            isValid: false,
            isDuplicate: false,
            errorReason: `Row ${r.rowNumber} — missing required phone number`,
          });
          continue;
        }

        const phoneVal = normalizeE164PhoneNumber(rawPhone);
        if (!phoneVal.isValid || !phoneVal.normalized) {
          invalids++;
          results.push({
            rowNumber: r.rowNumber,
            data: d,
            isValid: false,
            isDuplicate: false,
            errorReason: `Row ${r.rowNumber} — invalid phone format ("${rawPhone}")`,
          });
          continue;
        }

        const normalizedPhone = phoneVal.normalized;

        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          invalids++;
          results.push({
            rowNumber: r.rowNumber,
            data: d,
            isValid: false,
            isDuplicate: false,
            errorReason: `Row ${r.rowNumber} — invalid email address ("${email}")`,
          });
          continue;
        }

        if (existingPhoneSet.has(normalizedPhone) || seenBatchPhoneSet.has(normalizedPhone)) {
          dupes++;
          results.push({
            rowNumber: r.rowNumber,
            data: d,
            isValid: false,
            isDuplicate: true,
            errorReason: `Row ${r.rowNumber} — duplicate phone number (${normalizedPhone})`,
          });
          continue;
        }

        seenBatchPhoneSet.add(normalizedPhone);
        ready++;
        results.push({
          rowNumber: r.rowNumber,
          data: { ...d, phone: normalizedPhone },
          isValid: true,
          isDuplicate: false,
        });
      }

      setValidatedRows(results);
      setReadyCount(ready);
      setDuplicateCount(dupes);
      setInvalidCount(invalids);
    } catch (err: any) {
      console.error('Error parsing CSV:', err);
      setGeneralError('Failed to parse CSV file.');
    } finally {
      setIsParsing(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processCsvFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processCsvFile(e.target.files[0]);
    }
  };

  // Submit Bulk Import
  const handleExecuteImport = async () => {
    const validItems = validatedRows
      .filter((r) => r.isValid)
      .map((r) => ({
        first_name: r.data.first_name || '',
        last_name: r.data.last_name || '',
        full_name: `${r.data.first_name || ''} ${r.data.last_name || ''}`.trim() || r.data.phone,
        phone: r.data.phone,
        email: r.data.email || '',
        company: r.data.company || '',
        notes: r.data.notes || '',
      }));

    if (validItems.length === 0) {
      setGeneralError('No valid unique contacts available to import.');
      return;
    }

    setIsImporting(true);
    setGeneralError(null);

    try {
      const res = await fetch('/api/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts: validItems }),
      });

      const data = await res.json();

      if (!res.ok) {
        setGeneralError(data.error || 'Failed to import contacts.');
        return;
      }

      setImportSummary(
        `Import Complete: ${data.importedCount} contacts added, ${data.skippedDuplicatesCount} duplicates skipped, ${data.invalidCount} invalid rows skipped.`
      );
      onSuccess();
      setTimeout(() => {
        handleClose();
      }, 1500);
    } catch (err: any) {
      console.error('Error importing contacts:', err);
      setGeneralError('Network error performing bulk import.');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
      <div className="w-full max-w-2xl rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-600/10 border border-blue-500/20 text-blue-400">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">Bulk Import Contacts (CSV)</h2>
              <p className="text-xs text-slate-400">Upload CSV file to import multiple client records at once.</p>
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
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {/* Top Download Template Bar */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 text-xs">
            <div className="flex items-center gap-2 text-slate-300">
              <Info className="w-4 h-4 text-blue-400 shrink-0" />
              <span>Supported columns: <strong>first_name, last_name, phone, email, company, notes</strong></span>
            </div>
            <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>
              <Download className="w-3.5 h-3.5 text-blue-400" />
              <span>CSV Template</span>
            </Button>
          </div>

          {generalError && (
            <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 text-xs flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{generalError}</span>
            </div>
          )}

          {importSummary && (
            <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-800 text-emerald-200 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{importSummary}</span>
            </div>
          )}

          {/* Upload Dropzone */}
          {!file && (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`p-8 rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-3 cursor-pointer transition-all ${
                isDragOver
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-slate-800 hover:border-slate-700 bg-slate-950/50'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleFileChange}
              />
              <div className="p-3 rounded-2xl bg-blue-600/10 border border-blue-500/20 text-blue-400">
                <UploadCloud className="w-8 h-8" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-slate-200">
                  Drag & drop your CSV file here or <span className="text-blue-400 underline">Browse File</span>
                </p>
                <p className="text-xs text-slate-500 mt-1">Maximum 500 contacts per batch file.</p>
              </div>
            </div>
          )}

          {/* Parsing Spinner */}
          {isParsing && (
            <div className="p-8 text-center text-xs text-slate-400 flex flex-col items-center justify-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
              <span>Parsing and validating CSV contents...</span>
            </div>
          )}

          {/* Validation Metrics & Preview Table */}
          {file && !isParsing && validatedRows.length > 0 && (
            <div className="space-y-4">
              {/* File Info Bar */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950/80 border border-slate-800 text-xs">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-blue-400" />
                  <span className="font-mono text-slate-200 font-semibold">{file.name}</span>
                  <span className="text-slate-500">({(file.size / 1024).toFixed(1)} KB)</span>
                </div>
                <button
                  onClick={() => {
                    setFile(null);
                    setValidatedRows([]);
                  }}
                  className="text-xs text-slate-400 hover:text-slate-200 underline"
                >
                  Change File
                </button>
              </div>

              {/* Summary Stats Badges */}
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 rounded-xl bg-emerald-100 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800/60 text-center">
                  <p className="text-lg font-extrabold text-emerald-600 dark:text-emerald-400 font-mono">{readyCount}</p>
                  <p className="text-[11px] text-emerald-800 dark:text-emerald-300/80 font-medium">Ready to Import</p>
                </div>

                <div className="p-3 rounded-xl bg-amber-100 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800/60 text-center">
                  <p className="text-lg font-extrabold text-amber-600 dark:text-amber-400 font-mono">{duplicateCount}</p>
                  <p className="text-[11px] text-amber-800 dark:text-amber-300/80 font-medium">Duplicates (Skipped)</p>
                </div>

                <div className="p-3 rounded-xl bg-rose-100 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800/60 text-center">
                  <p className="text-lg font-extrabold text-rose-600 dark:text-rose-400 font-mono">{invalidCount}</p>
                  <p className="text-[11px] text-rose-800 dark:text-rose-300/80 font-medium">Invalid Rows (Skipped)</p>
                </div>
              </div>

              {/* Invalid Rows Callout List */}
              {validatedRows.some((r) => r.errorReason) && (
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5 max-h-32 overflow-y-auto text-[11px]">
                  <p className="font-semibold text-slate-400 uppercase tracking-wider text-[10px]">Row Validation Issues:</p>
                  {validatedRows
                    .filter((r) => r.errorReason)
                    .map((r) => (
                      <p key={r.rowNumber} className={r.isDuplicate ? 'text-amber-400' : 'text-rose-400'}>
                        {r.errorReason}
                      </p>
                    ))}
                </div>
              )}

              {/* Preview Table */}
              <div className="border border-slate-800 rounded-xl overflow-hidden max-h-48 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950 text-slate-400 font-mono uppercase text-[10px] sticky top-0">
                    <tr>
                      <th className="p-2.5 border-b border-slate-800">#</th>
                      <th className="p-2.5 border-b border-slate-800">Name</th>
                      <th className="p-2.5 border-b border-slate-800">Phone</th>
                      <th className="p-2.5 border-b border-slate-800">Company</th>
                      <th className="p-2.5 border-b border-slate-800">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
                    {validatedRows.slice(0, 15).map((r) => (
                      <tr key={r.rowNumber} className="hover:bg-slate-800/40">
                        <td className="p-2.5 text-slate-500 font-mono">{r.rowNumber}</td>
                        <td className="p-2.5 font-semibold text-slate-200">
                          {`${r.data.first_name || ''} ${r.data.last_name || ''}`.trim() || '—'}
                        </td>
                        <td className="p-2.5 font-mono text-slate-300">{r.data.phone || '—'}</td>
                        <td className="p-2.5 text-slate-400">{r.data.company || '—'}</td>
                        <td className="p-2.5">
                          {r.isValid ? (
                            <Badge variant="emerald" size="sm">Ready</Badge>
                          ) : r.isDuplicate ? (
                            <Badge variant="amber" size="sm">Duplicate</Badge>
                          ) : (
                            <Badge variant="rose" size="sm">Invalid</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-800 flex items-center justify-end gap-3">
          <Button variant="outline" size="md" onClick={handleClose} disabled={isImporting}>
            Cancel
          </Button>
          {file && readyCount > 0 && (
            <Button variant="success" size="md" onClick={handleExecuteImport} disabled={isImporting}>
              {isImporting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Importing...</span>
                </>
              ) : (
                <>
                  <Users className="w-4 h-4" />
                  <span>Import {readyCount} Contacts</span>
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
