import './frames.css';

import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** The screens' design sizes (CSS px): each renders at this size and is scaled to its frame. */
export const LAPTOP_SCREEN = { width: 1280, height: 800 } as const;
export const PHONE_SCREEN = { width: 390, height: 844 } as const;

/** Below this width only the phone is shown (frames.css uses the same breakpoint). */
export const PHONE_ONLY = '(max-width: 47.99rem)';

/**
 * A laptop and a phone drawn in CSS (no images), their screens' contents scaled from their design sizes with one
 * ResizeObserver, so the product's own text stays vector-crisp at any size. The frames keep their colours in both
 * themes (devices are physical); what the screens show follows the page's theme.
 */
export function DeviceStage({
  laptop,
  phone,
  className,
}: {
  laptop?: ReactNode;
  phone?: ReactNode;
  className?: string;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const screens = [...stage.querySelectorAll<HTMLElement>('[data-design-width]')];
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const screen = entry.target as HTMLElement;
        const design = Number(screen.dataset.designWidth);
        if (design > 0) screen.style.setProperty('--s', (entry.contentRect.width / design).toFixed(4));
      }
    });
    for (const screen of screens) observer.observe(screen);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={stageRef} className={cn('ad-box', className)}>
      <div className="ad-stage">
        <div className="ad-laptop">
          <div className="ad-laptop__lid">
            <div className="ad-screen" data-design-width={LAPTOP_SCREEN.width}>
              <div className="ad-canvas ad-canvas--laptop">{laptop}</div>
            </div>
          </div>
          <div className="ad-laptop__base" />
        </div>
        <div className="ad-phone">
          <div className="ad-screen ad-screen--phone" data-design-width={PHONE_SCREEN.width}>
            <div className="ad-canvas ad-canvas--phone">{phone}</div>
          </div>
          <span className="ad-phone__island" />
        </div>
      </div>
    </div>
  );
}
