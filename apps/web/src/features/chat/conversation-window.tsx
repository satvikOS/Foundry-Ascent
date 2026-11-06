import type { ComponentProps } from 'react';

import { useBreathingGround } from '@/components/shell/shell-chrome';
import { cn } from '@/lib/utils';

/**
 * The conversation with the mentor as a window (owner, 2026-11-06: "larger, floating, with a glassy touch"): New chat
 * and every conversation sit in it. From 768 px it floats over the breathing ground, inset from the side panels and
 * the viewport with the panels' corners, and uses all the room between them; on a phone it is a full-bleed sheet. The
 * pane is a sticky layer behind the content (globals.css `.conv-window`), so the page keeps scrolling as a whole and
 * the reading column inside keeps its measure. The window's first header (`data-slot="conversation-header"`) rides its
 * top edge and its composer dock its bottom edge.
 */
export function ConversationWindow({ className, children, ...props }: ComponentProps<'div'>) {
  useBreathingGround();
  return (
    <div
      data-slot="conversation-window"
      className={cn('conv-window flex flex-1 flex-col', className)}
      {...props}
    >
      <div aria-hidden data-slot="conversation-window-frame" className="conv-window-frame" />
      {children}
    </div>
  );
}
