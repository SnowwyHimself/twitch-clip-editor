// electron-builder afterSign hook. Without a paid Apple Developer Program
// membership there's no "Developer ID Application" identity to sign with,
// so electron-builder skips signing entirely and ships an app where only
// Electron's own pre-built binary carries a signature — one that doesn't
// cover the resources/code we added. macOS Gatekeeper's stricter arm64
// signature-vs-contents check then reports the whole app as "damaged"
// rather than the milder "unidentified developer" warning.
//
// Re-signing everything ad hoc (no identity, just `--sign -`) properly
// seals the full bundle contents against its own signature. That doesn't
// grant real Gatekeeper trust (no notarization without a paid account —
// the user still gets an "unidentified developer" prompt on first open,
// which they can click through), but it fixes the hard "damaged, can't be
// opened at all" false positive, confirmed by testing exactly this locally.
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterSign] Deep ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--deep', '--force', '--sign', '-', appPath], { stdio: 'inherit' });
};
