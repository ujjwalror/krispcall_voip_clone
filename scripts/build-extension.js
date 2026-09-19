const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'chrome-extension', 'src');
const distDir = path.join(rootDir, 'chrome-extension', 'dist');

console.log('[BUILD EXTENSION] Starting reproducible Chrome Extension build...');

// 1. Ensure clean dist structure
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}

fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(path.join(distDir, 'lib'), { recursive: true });
fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });

// 2. Copy standalone bundled Twilio Voice JS SDK from node_modules
const twilioSrc = path.join(rootDir, 'node_modules', '@twilio', 'voice-sdk', 'dist', 'twilio.min.js');
const twilioDest = path.join(distDir, 'lib', 'twilio.min.js');

if (fs.existsSync(twilioSrc)) {
  fs.copyFileSync(twilioSrc, twilioDest);
  console.log('[BUILD EXTENSION] Copied @twilio/voice-sdk bundle to chrome-extension/dist/lib/twilio.min.js');
} else {
  console.error('[BUILD EXTENSION] ERROR: twilio.min.js not found in node_modules/@twilio/voice-sdk/dist/');
  process.exit(1);
}

// 3. Copy manifest.json
const manifestSrc = path.join(rootDir, 'chrome-extension', 'manifest.json');
fs.copyFileSync(manifestSrc, path.join(distDir, 'manifest.json'));

// 4. Copy HTML & CSS files
const staticFiles = ['dialer-window.html', 'dialer-window.css', 'content.css'];
staticFiles.forEach((file) => {
  const src = path.join(srcDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(distDir, file));
  }
});

// Copy assets
const svgSrc = path.join(srcDir, 'assets', 'phone-icon.svg');
if (fs.existsSync(svgSrc)) {
  fs.copyFileSync(svgSrc, path.join(distDir, 'assets', 'phone-icon.svg'));
}

// 5. Compile TypeScript files using esbuild
const tsFiles = [
  { in: path.join(srcDir, 'background.ts'), out: path.join(distDir, 'background.js') },
  { in: path.join(srcDir, 'content.ts'), out: path.join(distDir, 'content.js') },
  { in: path.join(srcDir, 'dialer-window.ts'), out: path.join(distDir, 'dialer-window.js') },
];

tsFiles.forEach((item) => {
  console.log(`[BUILD EXTENSION] Compiling ${path.basename(item.in)} -> ${path.basename(item.out)}`);
  try {
    execSync(`npx esbuild "${item.in}" --outfile="${item.out}" --bundle --target=es2020 --format=iife --platform=browser`, {
      stdio: 'inherit',
      cwd: rootDir,
    });
  } catch (err) {
    console.error(`[BUILD EXTENSION] Error compiling ${item.in}:`, err);
    process.exit(1);
  }
});

console.log('[BUILD EXTENSION] Extension build completed successfully! Output directory: chrome-extension/dist/');
