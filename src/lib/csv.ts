/**
 * Robust zero-dependency CSV parser and template generator.
 */

export interface ParsedCsvRow {
  rowNumber: number;
  data: Record<string, string>;
  raw: string;
}

export interface CsvParseResult {
  headers: string[];
  rows: ParsedCsvRow[];
  errors: string[];
}

/**
 * Parses raw CSV text into structured headers and rows.
 */
export function parseCsvText(csvText: string): CsvParseResult {
  const result: CsvParseResult = {
    headers: [],
    rows: [],
    errors: [],
  };

  if (!csvText || !csvText.trim()) {
    result.errors.push('The provided CSV file is empty.');
    return result;
  }

  // Split lines accounting for \r\n and \n
  const lines = parseCsvLines(csvText);
  if (lines.length === 0) {
    result.errors.push('No readable lines found in CSV file.');
    return result;
  }

  // Parse headers from first line
  const rawHeaders = parseCsvRecord(lines[0]);
  result.headers = rawHeaders.map((h) => normalizeHeader(h));

  if (result.headers.length === 0 || !result.headers.some((h) => Boolean(h))) {
    result.errors.push('Invalid CSV header row.');
    return result;
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine || !rawLine.trim()) continue; // Skip empty rows

    const values = parseCsvRecord(rawLine);
    const rowData: Record<string, string> = {};

    result.headers.forEach((header, idx) => {
      if (header) {
        rowData[header] = (values[idx] || '').trim();
      }
    });

    result.rows.push({
      rowNumber: i + 1,
      data: rowData,
      raw: rawLine,
    });
  }

  return result;
}

/**
 * Normalizes header string to canonical key names.
 */
function normalizeHeader(header: string): string {
  const clean = header.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (clean.includes('first') || clean === 'fname') return 'first_name';
  if (clean.includes('last') || clean === 'lname') return 'last_name';
  if (clean.includes('phone') || clean.includes('mobile') || clean.includes('tel') || clean.includes('number')) return 'phone';
  if (clean.includes('email') || clean.includes('mail')) return 'email';
  if (clean.includes('company') || clean.includes('org') || clean.includes('organization')) return 'company';
  if (clean.includes('note') || clean.includes('comment') || clean.includes('remark')) return 'notes';
  return clean;
}

/**
 * Parses full CSV content into array of record lines, supporting quoted newlines.
 */
function parseCsvLines(text: string): string[] {
  const lines: string[] = [];
  let currentLine = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentLine += '"';
        i++; // Skip escaped quote
      } else {
        inQuotes = !inQuotes;
        currentLine += '"';
      }
    } else if ((char === '\r' && nextChar === '\n' && !inQuotes) || (char === '\n' && !inQuotes)) {
      if (char === '\r') i++;
      lines.push(currentLine);
      currentLine = '';
    } else {
      currentLine += char;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Parses single CSV line into array of field strings.
 */
function parseCsvRecord(line: string): string[] {
  const fields: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(currentField.trim());
      currentField = '';
    } else {
      currentField += char;
    }
  }

  fields.push(currentField.trim());
  return fields;
}

/**
 * Generates sample CSV template for contacts import.
 */
export function generateContactsCsvTemplate(): string {
  const headers = ['first_name', 'last_name', 'phone', 'email', 'company', 'notes'];
  const sampleRow1 = ['Jane', 'Smith', '+61412345678', 'jane.smith@acme.com', 'Acme Corp', 'Enterprise decision maker'];
  const sampleRow2 = ['Robert', 'Taylor', '+15550198821', 'rtaylor@cyberdyne.io', 'Cyberdyne Systems', 'Interested in VoIP bulk numbers'];

  return [headers.join(','), sampleRow1.map(csvEscape).join(','), sampleRow2.map(csvEscape).join(',')].join('\n');
}

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}
