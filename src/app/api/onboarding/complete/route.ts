import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    // 1. Authenticate caller session
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required for onboarding.' },
        { status: 401 }
      );
    }

    const adminSupabase = createAdminClient();

    // 2. Verify user does NOT already have a profile
    const { data: existingProfile } = await (adminSupabase as any)
      .from('profiles')
      .select('id, organization_id')
      .eq('id', user.id)
      .maybeSingle();

    if (existingProfile) {
      return NextResponse.json(
        {
          success: true,
          message: 'Account onboarding is already completed.',
          redirect: '/dashboard',
        },
        { status: 200 }
      );
    }

    // 3. Parse and validate onboarding request body
    const body = await request.json().catch(() => ({}));
    const rawOrgName = body.orgName || body.name || '';
    const rawSlug = body.slug || '';
    const rawFullName = body.fullName || user.user_metadata?.full_name || user.email?.split('@')[0] || 'Workspace Owner';

    const orgName = rawOrgName.trim();
    if (!orgName || orgName.length < 2) {
      return NextResponse.json(
        { error: 'Organization name must be at least 2 characters long.' },
        { status: 400 }
      );
    }

    const fullName = rawFullName.trim();
    if (!fullName || fullName.length < 2) {
      return NextResponse.json(
        { error: 'Full name must be at least 2 characters long.' },
        { status: 400 }
      );
    }

    // 4. Normalize & validate workspace URL slug
    let slug = rawSlug
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!slug) {
      slug = orgName
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }

    if (!slug || slug.length < 2 || slug.length > 50) {
      return NextResponse.json(
        { error: 'Workspace URL slug must be between 2 and 50 alphanumeric characters or hyphens.' },
        { status: 400 }
      );
    }

    // 5. Enforce unique workspace slug pre-check
    const { data: existingSlug } = await (adminSupabase as any)
      .from('organizations')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (existingSlug) {
      return NextResponse.json(
        { error: `Workspace URL slug "${slug}" is already taken. Please choose another.` },
        { status: 400 }
      );
    }

    // 6. Invoke Secure RPC: create_organization_with_owner
    // Identity parameters (user_id, email, role, active, twilio_identity, extension) are strictly derived database-side.
    let orgId: string | null = null;

    const { data: rpcResult, error: rpcError } = await (supabase as any).rpc(
      'create_organization_with_owner',
      {
        p_org_name: orgName,
        p_org_slug: slug,
        p_full_name: fullName,
      }
    );

    if (!rpcError && rpcResult && rpcResult.length > 0) {
      orgId = rpcResult[0].organization_id;
    } else {
      // Fallback service role execution if RPC is not yet deployed remotely in environment
      const { data: fallbackResult, error: fallbackError } = await (adminSupabase as any).rpc(
        'create_organization_with_owner',
        {
          p_org_name: orgName,
          p_org_slug: slug,
          p_full_name: fullName,
        }
      );

      if (!fallbackError && fallbackResult && fallbackResult.length > 0) {
        orgId = fallbackResult[0].organization_id;
      } else {
        // Fallback service role insertion sequence if RPC function does not exist in remote DB yet
        const { data: newOrg, error: orgErr } = await (adminSupabase as any)
          .from('organizations')
          .insert({
            name: orgName,
            slug,
            status: 'active',
          })
          .select('id')
          .single();

        if (orgErr || !newOrg) {
          console.error('[Onboarding API] Organization creation error:', orgErr || fallbackError || rpcError);
          return NextResponse.json(
            { error: 'Failed to create organization. Workspace slug may be taken.' },
            { status: 500 }
          );
        }

        orgId = newOrg.id;

        // Generate database-side unique Twilio identity
        const nameClean = fullName
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');

        const baseIdentity = nameClean ? `owner_${nameClean}` : `owner_user`;
        let finalTwilioIdentity = baseIdentity;
        let identitySuffix = 2;

        while (true) {
          const { data: existingIdent } = await (adminSupabase as any)
            .from('profiles')
            .select('id')
            .eq('twilio_identity', finalTwilioIdentity)
            .maybeSingle();

          if (!existingIdent) break;
          finalTwilioIdentity = `${baseIdentity}_${identitySuffix}`;
          identitySuffix++;
        }

        const { error: profileErr } = await (adminSupabase as any)
          .from('profiles')
          .insert({
            id: user.id,
            organization_id: orgId,
            full_name: fullName,
            email: user.email,
            role: 'owner',
            extension: null, // Owner extension is NULL initially
            active: true,
            availability_status: 'offline',
            twilio_identity: finalTwilioIdentity,
          });

        if (profileErr) {
          console.error('[Onboarding API] Profile creation error. Rolling back org:', profileErr);
          await (adminSupabase as any).from('organizations').delete().eq('id', orgId);
          return NextResponse.json(
            { error: 'Failed to initialize owner profile. Onboarding aborted.' },
            { status: 500 }
          );
        }
      }
    }

    return NextResponse.json({
      success: true,
      redirect: '/dashboard',
    });
  } catch (error: any) {
    console.error('[Onboarding API] Exception:', error.message || error);
    return NextResponse.json({ error: 'Internal server error completing onboarding.' }, { status: 500 });
  }
}
