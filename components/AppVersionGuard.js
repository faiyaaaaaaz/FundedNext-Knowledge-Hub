import { useEffect, useRef, useState } from 'react';

const CHECK_EVERY_MS = 60_000;
const RELOAD_AFTER_MS = 5_000;

export default function AppVersionGuard() {
  const initialVersion = useRef(null);
  const reloading = useRef(false);
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    let active = true;
    let reloadTimer;

    async function checkVersion() {
      if (!active || reloading.current) return;
      try {
        const response = await fetch(`/api/app-version?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;
        const { version } = await response.json();
        if (!version) return;
        if (!initialVersion.current) {
          initialVersion.current = version;
          return;
        }
        if (version === initialVersion.current) return;
        reloading.current = true;
        setUpdateReady(true);
        reloadTimer = window.setTimeout(() => window.location.reload(), RELOAD_AFTER_MS);
      } catch {
        // A temporary network failure is not evidence of a new deployment.
      }
    }

    const interval = window.setInterval(checkVersion, CHECK_EVERY_MS);
    const onVisible = () => document.visibilityState === 'visible' && checkVersion();
    window.addEventListener('focus', checkVersion);
    document.addEventListener('visibilitychange', onVisible);
    checkVersion();
    return () => {
      active = false;
      window.clearInterval(interval);
      window.clearTimeout(reloadTimer);
      window.removeEventListener('focus', checkVersion);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!updateReady) return null;
  return <div className="app-update-banner" role="status" aria-live="assertive"><span>↻</span><div><b>A newer app version is ready</b><small>Refreshing automatically so this device uses the latest fixes. Your sign-in stays active.</small></div></div>;
}
