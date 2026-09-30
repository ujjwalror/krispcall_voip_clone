import fs from 'fs';
import path from 'path';

const envPath = path.resolve('.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
      process.env[key] = val;
    }
  }
}

async function auditVercelProjectIdentity() {
  const targetDomain = 'https://krispcall-voip-clone-udlg.vercel.app';
  console.log(`=== AUDITING VERCEL PROJECT IDENTITY FOR DOMAIN: ${targetDomain} ===\n`);

  const res = await fetch(targetDomain, { method: 'HEAD' });
  console.log('Domain Status:', res.status, res.statusText);
  console.log('Headers:');
  let vercelId = '';
  res.headers.forEach((val, key) => {
    if (key.includes('vercel') || key.includes('x-') || key === 'server' || key === 'date') {
      console.log(`  ${key}: ${val}`);
    }
    if (key === 'x-vercel-id') vercelId = val;
  });

  // Extract Vercel deployment project handle from URL: krispcall-voip-clone-udlg
  // Domain pattern: <project-name>-<hash>-<scope>.vercel.app or <project-name>.vercel.app
  console.log('\nAnalyzing Domain Structure:');
  console.log('Domain:', 'krispcall-voip-clone-udlg.vercel.app');
  console.log('Extracted Vercel Project Name:', 'krispcall-voip-clone-udlg');

  // Check if GITHUB_PAT is present in env to query Vercel or GitHub deployment status
  const githubPat = process.env.GITHUB_PAT;
  if (githubPat) {
    console.log('\nChecking GitHub Repository Deployments for ujjwalror/krispcall_voip_clone via GitHub API...');
    const ghRes = await fetch('https://api.github.com/repos/ujjwalror/krispcall_voip_clone/deployments', {
      headers: {
        'Authorization': `Bearer ${githubPat}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Node.js',
      },
    });

    if (ghRes.ok) {
      const deployments = await ghRes.json();
      console.log(`Found ${deployments.length} GitHub deployments:`);
      for (const d of deployments.slice(0, 3)) {
        console.log(`  - Deployment ID: ${d.id}`);
        console.log(`    Ref/Commit: ${d.ref} (${d.sha})`);
        console.log(`    Environment: ${d.environment}`);
        console.log(`    Created At: ${d.created_at}`);
        console.log(`    Description: ${d.description || 'N/A'}`);
      }
    } else {
      console.log('GitHub API error:', ghRes.status, ghRes.statusText);
    }
  }
}

auditVercelProjectIdentity().catch(console.error);
