import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { CirclePause, DatabaseZap, KeyRound, WifiOff } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { announce } from '@/components/a11y/live-announcer';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { meQueryOptions } from '@/lib/api/hooks/auth';
import { resumingStore, useResumingState } from '@/lib/api/resuming';
import { formatDate } from '@/lib/format';
import { safeStorage, STORAGE_KEYS } from '@/lib/storage';
import { cn } from '@/lib/utils';

const TYPICAL_RESUME_SECONDS = 15;

function BannerShell({
  icon,
  children,
  action,
  tone = 'neutral',
  live,
}: {
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'warning';
  live: 'polite' | 'off';
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden"
    >
      <div
        role={live === 'polite' ? 'status' : undefined}
        aria-live={live}
        className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 text-[13px]',
          tone === 'warning' ? 'border-warning/40 bg-warning/10' : 'border-border bg-muted',
        )}
      >
        <span className="flex shrink-0 items-center">{icon}</span>
        <div className="min-w-0 flex-1">{children}</div>
        {action}
      </div>
    </motion.div>
  );
}

function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [active, intervalMs]);
  return now;
}

/** "Waking up your workspace…" while requests wait for Aurora to resume. */
export function DbWakingBanner() {
  const { waiting, since, lastResumedAt } = useResumingState();
  const active = waiting > 0 && since !== null;
  const now = useNow(active);
  const elapsed = active ? Math.max(0, Math.round((now - since) / 1000)) : 0;
  const wasActive = useRef(false);
  const lastAnnouncedResume = useRef(lastResumedAt);

  useEffect(() => {
    if (active && !wasActive.current)
      announce('Waking up your workspace. This usually takes about 15 seconds.');
    wasActive.current = active;
  }, [active]);

  useEffect(() => {
    if (lastResumedAt !== null && lastResumedAt !== lastAnnouncedResume.current)
      announce('Your workspace is ready.');
    lastAnnouncedResume.current = lastResumedAt;
  }, [lastResumedAt]);

  const progress = Math.min(95, (elapsed / TYPICAL_RESUME_SECONDS) * 100);

  return (
    <AnimatePresence initial={false}>
      {active ? (
        <BannerShell
          key="db-waking"
          live="off"
          tone="warning"
          icon={<DatabaseZap aria-hidden className="size-4 text-warning motion-safe:animate-pulse" />}
          action={
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                resumingStore.cancelAll();
              }}
            >
              Cancel
            </Button>
          }
        >
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
            <p>
              <span className="font-medium">Waking up your workspace…</span>{' '}
              <span className="text-muted-foreground">
                The database pauses when idle to keep costs low. This usually takes about{' '}
                {TYPICAL_RESUME_SECONDS} seconds.
              </span>
            </p>
            <div className="flex items-center gap-2 sm:ml-auto">
              <Progress
                value={progress}
                label="Workspace waking progress"
                className="w-28"
                indicatorClassName="bg-warning"
              />
              <span className="tabular w-8 text-xs text-muted-foreground" aria-hidden>
                {elapsed}s
              </span>
            </div>
          </div>
        </BannerShell>
      ) : null}
    </AnimatePresence>
  );
}

function subscribeOnline(listener: () => void) {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** Shown while the browser reports no network. */
export function OfflineBanner() {
  const online = useOnline();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (online) return;
    }
    announce(
      online ? 'You are back online.' : 'You are offline. Changes can’t be saved until you reconnect.',
    );
  }, [online]);

  return (
    <AnimatePresence initial={false}>
      {online ? null : (
        <BannerShell
          key="offline"
          live="off"
          icon={<WifiOff aria-hidden className="size-4 text-muted-foreground" />}
        >
          <p>
            <span className="font-medium">You’re offline.</span>{' '}
            <span className="text-muted-foreground">
              You can keep reading what’s loaded. Changes can’t be saved until you reconnect.
            </span>
          </p>
        </BannerShell>
      )}
    </AnimatePresence>
  );
}

/** Global AI kill switch notice (platform_settings.ai_enabled = false), from /me. */
export function AiDisabledBanner() {
  const { data: me } = useQuery(meQueryOptions());
  return (
    <AnimatePresence initial={false}>
      {me && !me.aiEnabled ? (
        <BannerShell
          key="ai-disabled"
          live="polite"
          tone="warning"
          icon={<CirclePause aria-hidden className="size-4 text-warning" />}
        >
          <p>
            <span className="font-medium">AI coaching is paused.</span>{' '}
            <span className="text-muted-foreground">
              An administrator turned off the coach. Your workspace, memory and documents remain available.
            </span>
          </p>
        </BannerShell>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * "A new access code was issued for your account on <date>": someone else (an administrator) issued a code
 * for this account since the person's previous sign-in (`Me.notices`, computed by the API per sign-in).
 * Expected after asking for a new code; otherwise the person should tell the program team. Dismissible;
 * a newer re-issue shows again.
 */
export function AccessCodeNoticeBanner() {
  const { data: me } = useQuery(meQueryOptions());
  // `access_code_issued` is the only notice kind so far; the newest comes first.
  const latest = me?.notices[0] ?? null;
  const [dismissed, setDismissed] = useState(() => safeStorage.get(STORAGE_KEYS.accessCodeNoticeDismissed));
  const show = latest !== null && dismissed !== latest.at;
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <BannerShell
          key="access-code-notice"
          live="polite"
          tone="warning"
          icon={<KeyRound aria-hidden className="size-4 text-warning" />}
          action={
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                safeStorage.set(STORAGE_KEYS.accessCodeNoticeDismissed, latest.at);
                setDismissed(latest.at);
              }}
            >
              Dismiss
            </Button>
          }
        >
          <p data-testid="access-code-notice">
            <span className="font-medium">
              A new access code was issued for your account on {formatDate(latest.at)}.
            </span>{' '}
            <span className="text-muted-foreground">
              If you didn’t ask for one, tell your program team right away.
            </span>
          </p>
        </BannerShell>
      ) : null}
    </AnimatePresence>
  );
}
