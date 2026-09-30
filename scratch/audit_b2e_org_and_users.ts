import { createClient } from "@supabase/supabase-js";
import fs from "fs";

(globalThis as any).WebSocket = class {};

function getEnvVars() {
  const envText = fs.readFileSync(".env.local", "utf-8");
  const env: Record<string, string> = {};
  for (const line of envText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      env[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
    }
  }
  return env;
}

async function main() {
  const env = getEnvVars();
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error("Missing Supabase credentials in .env.local");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { timeout: 10000 }
  });

  console.log("=== 1. ORGANIZATION 000...001 AUDIT ===");
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("*")
    .eq("id", "00000000-0000-0000-0000-000000000001")
    .single();
  
  if (orgErr) {
    console.error("Org query error:", orgErr);
  } else {
    console.log("Org Details:", JSON.stringify(org, null, 2));
  }

  console.log("\n=== 2. ALL ORGANIZATIONS ===");
  const { data: allOrgs } = await supabase.from("organizations").select("*");
  console.log("All Orgs:", JSON.stringify(allOrgs, null, 2));

  console.log("\n=== 3. ORGANIZATION MEMBERS FOR 000...001 ===");
  const { data: members, error: memErr } = await supabase
    .from("organization_members")
    .select("*")
    .eq("organization_id", "00000000-0000-0000-0000-000000000001");
  console.log("Org Members:", memErr ? memErr : JSON.stringify(members, null, 2));

  console.log("\n=== 4. ALL ORGANIZATION MEMBERS IN SYSTEM ===");
  const { data: allMembers } = await supabase.from("organization_members").select("*");
  console.log("All Members:", JSON.stringify(allMembers, null, 2));

  console.log("\n=== 5. AUTH USERS IN SUPABASE ===");
  const { data: authUsers, error: authErr } = await supabase.auth.admin.listUsers();
  if (authErr) {
    console.error("Auth Users error:", authErr);
  } else {
    console.log("Auth Users:", authUsers.users.map(u => ({
      id: u.id,
      email: u.email,
      phone: u.phone,
      created_at: u.created_at,
      user_metadata: u.user_metadata,
      app_metadata: u.app_metadata
    })));
  }

  console.log("\n=== 6. PHONE NUMBERS IN SYSTEM ===");
  const { data: numbers } = await supabase.from("phone_numbers").select("*");
  console.log("Phone Numbers:", JSON.stringify(numbers, null, 2));
}

main().catch(console.error);
