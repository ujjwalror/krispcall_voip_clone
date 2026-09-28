import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { CommercialRecoveryRunnerService } from '../../../../lib/billing/commercialRecoveryRunnerService';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return handleRequest(req);
}

export async function GET(req: NextRequest) {
  return handleRequest(req);
}

async function handleRequest(req: NextRequest) {
  // 1. Fail-Closed Secret Configuration Check
  const configuredSecret = process.env.RECOVERY_RUNNER_SECRET;
  if (!configuredSecret || configuredSecret.length < 32) {
    return NextResponse.json(
      { error: 'Server configuration error: Invalid or missing RECOVERY_RUNNER_SECRET.' },
      { status: 500 }
    );
  }

  // 2. Extract Bearer / Custom Header Authorization Token
  const authHeader = req.headers.get('authorization') || '';
  const customHeader = req.headers.get('x-recovery-runner-secret') || '';

  let providedToken = '';
  if (authHeader.startsWith('Bearer ')) {
    providedToken = authHeader.substring(7).trim();
  } else if (customHeader) {
    providedToken = customHeader.trim();
  }

  if (!providedToken) {
    return NextResponse.json({ error: 'Unauthorized: Missing secret token.' }, { status: 401 });
  }

  // 3. Constant-Time Secret Comparison
  try {
    const providedBuffer = Buffer.from(providedToken);
    const expectedBuffer = Buffer.from(configuredSecret);

    if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
      return NextResponse.json({ error: 'Unauthorized: Invalid secret token.' }, { status: 401 });
    }
  } catch (e) {
    return NextResponse.json({ error: 'Unauthorized: Verification failed.' }, { status: 401 });
  }

  // 4. Initialize Server-Only Service Role Client
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'Server configuration error: Missing Supabase credentials.' }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 5. Execute Bounded Recovery Pass
  try {
    const summary = await CommercialRecoveryRunnerService.runRecoveryPass(supabase, {
      batchSize: 15,
      timeBudgetMs: 20000,
      expectedMode: (process.env.NEXT_PUBLIC_STRIPE_MODE as any) || 'test',
    });

    return NextResponse.json({
      success: true,
      summary,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Recovery runner execution failed.', details: err.message },
      { status: 500 }
    );
  }
}
