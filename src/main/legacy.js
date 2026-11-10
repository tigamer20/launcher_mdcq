// Launchers installed before the ATM rename are the "ModdedQC Launcher" Windows app. File updates can't change
// an app's name, icon or shortcuts, so that app gets the ATM installer once (see updater.js), and the new
// ATM Launcher then quietly uninstalls the old app. The game files (.atm folder) are shared and stay.
const { execFile, spawn } = require('child_process');
const { app } = require('electron');

const OLD_NAME = 'ModdedQC Launcher';

/** True when this copy runs inside the old ModdedQC Windows app. */
const isOldApp = () => process.platform === 'win32' && app.isPackaged && app.getName() !== 'ATM Launcher';

/** Runs the old app's silent uninstaller if it is still installed. Never throws. */
function removeOldApp() {
  if (process.platform !== 'win32' || !app.isPackaged || isOldApp()) return;
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  execFile('reg', ['query', key, '/s', '/v', 'QuietUninstallString'], { windowsHide: true }, (err, stdout) => {
    if (err || !stdout) return;
    const match = stdout.match(new RegExp(`"([^"]*\\\\Uninstall ${OLD_NAME}\\.exe)"`, 'i'));
    if (!match) return;
    try {
      spawn(match[1], ['/currentuser', '/S'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {
      // not important: the old app just stays installed
    }
  });
}

module.exports = { isOldApp, removeOldApp };
