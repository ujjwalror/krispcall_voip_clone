import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const fileRelPath = 'supabase/migrations/20261203000000_phase13_3_capture_primitives.sql';
const filePath = path.resolve(process.cwd(), fileRelPath);

if (!fs.existsSync(filePath)) {
  throw new Error(`Migration file not found at ${filePath}`);
}

const content = fs.readFileSync(filePath, 'utf8');
const buffer = fs.readFileSync(filePath);

const bytes = buffer.length;
const lines = content.split('\n').length;
const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

console.log(`File Path: ${fileRelPath}`);
console.log(`Byte Size: ${bytes} bytes`);
console.log(`Line Count: ${lines} lines`);
console.log(`SHA-256 Checksum: ${sha256}`);
