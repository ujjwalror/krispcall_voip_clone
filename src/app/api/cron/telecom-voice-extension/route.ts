import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { ActiveCallExtensionService } from '../../../../lib/billing/telecom/activeCallExtensionService';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  return handleRequest(req);
}

export async function GET(req: NextRequest) {
  return handleRequest(req);
}

async function handleRequest(req: NextRequest) {
  // 1. Fail-Closed Secret Configuration Check
  const configuredSecret = process.env.TELECOM_VOICE_EXTENSION_RUNNER_SECRET || process.env.RECOVERY_RUNNER_SECRET;
  if (!configuredSecret || configuredSecret.length < 16) {
    return NextResponse.json(
      { error: 'Server configuration error: Invalid or missing TELECOM_VOICE_EXTENSION_RUNNER_SECRET.' },
      { status: 500 }
    );
  }

  // 2. Extract Bearer / Custom Header Authorization Token
  const authHeader = req.headers.get('authorization') || '';
  const customHeader = req.headers.get('x-telecom-voice-extension-secret') || '';

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
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'Server configuration error: Missing Supabase credentials.' }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 5. Execute Single-Iteration Active Voice Extension Pass
  try {
    const workerId = `runner_node_${process.pid}_${Date.now()}`;
    const result = await ActiveCallExtensionService.processNextDueVoiceExtension(supabase, {
      workerId,
      leaseDurationSeconds: 30,
      extensionBlockSeconds: 60, // EXPERIMENT_PROVISIONAL
    });

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Telecom voice extension runner execution failed.', details: err.message },
      { status: 500 }
    );
  }
}
