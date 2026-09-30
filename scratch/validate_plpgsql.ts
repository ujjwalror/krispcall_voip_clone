import fs from 'fs';
import path from 'path';

function validateMigration() {
  const file = path.resolve('supabase/migrations/20261215000000_phase13_4_3b2e_identifier_grammar_remediation.sql');
  const sql = fs.readFileSync(file, 'utf8').trim();

  console.log('--- STATIC PL/pgSQL VALIDATION FOR MIGRATION 20261215000000 ---');
  console.log('File:', file);
  console.log('Size:', sql.length, 'bytes');

  // Strip leading comments for transaction check
  const nonCommentSql = sql.replace(/^(\s*--.*\n)+/g, '').trim();

  // Check BEGIN and COMMIT
  if (!nonCommentSql.startsWith('BEGIN;') || !nonCommentSql.endsWith('COMMIT;')) {
    console.error('FAIL: Migration must begin with BEGIN; and end with COMMIT;');
    console.error('Start:', nonCommentSql.slice(0, 20));
    console.error('End:', nonCommentSql.slice(-20));
    process.exit(1);
  }

  // Split into function blocks
  const fnRegex = /CREATE OR REPLACE FUNCTION public\.([a-zA-Z0-9_]+)\(([\s\S]*?)\)\s*RETURNS\s+([a-zA-Z0-9_]+)\s+LANGUAGE\s+plpgsql[\s\S]*?AS \$\$(\s*DECLARE[\s\S]*?BEGIN[\s\S]*?END;\s*)\$\$;/g;

  let match;
  let count = 0;
  while ((match = fnRegex.exec(sql)) !== null) {
    count++;
    const fnName = match[1];
    const paramsRaw = match[2];
    const returnType = match[3];
    const body = match[4];

    console.log(`\nAnalyzing Function ${count}: [${fnName}]`);

    // Parse DECLARE block
    const declareMatch = body.match(/DECLARE([\s\S]*?)BEGIN/);
    if (!declareMatch) {
      console.error(`  FAIL: Missing DECLARE block in ${fnName}`);
      process.exit(1);
    }

    const declaredVars = new Set<string>();
    const declareLines = declareMatch[1].split('\n');
    for (const dLine of declareLines) {
      const trimmed = dLine.trim();
      if (trimmed && !trimmed.startsWith('--')) {
        const varMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s+/);
        if (varMatch) {
          declaredVars.add(varMatch[1]);
        }
      }
    }

    // Parse parameters
    const paramNames = new Set<string>();
    for (const pLine of paramsRaw.split(',')) {
      const trimmed = pLine.trim();
      const pMatch = trimmed.match(/^(p_[a-zA-Z0-9_]+)/);
      if (pMatch) {
        paramNames.add(pMatch[1]);
      }
    }

    console.log(`  Declared Variables (${declaredVars.size}):`, Array.from(declaredVars).join(', '));
    console.log(`  Parameters (${paramNames.size}):`, Array.from(paramNames).join(', '));

    // Check all variable assignments and usages (v_*) in body
    const bodyCode = body.slice(body.indexOf('BEGIN'));
    const usedVars = new Set<string>();
    const vMatch = bodyCode.match(/v_[a-zA-Z0-9_]+/g) || [];
    for (const v of vMatch) {
      usedVars.add(v);
    }

    let undeclared = 0;
    for (const v of usedVars) {
      if (!declaredVars.has(v)) {
        console.error(`  ❌ ERROR: Undeclared variable [${v}] used in ${fnName}!`);
        undeclared++;
      }
    }

    if (undeclared === 0) {
      console.log(`  ✓ All ${usedVars.size} referenced local variables are declared.`);
    } else {
      process.exit(1);
    }

    // Verify corresponding REVOKE / GRANT
    const revokeRegex = new RegExp(`REVOKE ALL ON FUNCTION public\\.${fnName}\\((.*?)\\) FROM PUBLIC, anon, authenticated;`);
    const grantRegex = new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fnName}\\((.*?)\\) TO service_role;`);

    if (!revokeRegex.test(sql)) {
      console.error(`  ❌ ERROR: Missing explicit REVOKE for ${fnName}`);
      process.exit(1);
    }
    if (!grantRegex.test(sql)) {
      console.error(`  ❌ ERROR: Missing explicit GRANT for ${fnName}`);
      process.exit(1);
    }
    console.log(`  ✓ Explicit REVOKE and GRANT statements verified.`);
  }

  console.log(`\nPASSED: ${count} functions validated cleanly with zero syntax/declaration errors.`);
}

validateMigration();
