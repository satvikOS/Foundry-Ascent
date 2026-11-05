import { useMemo } from 'react';

import { SidebarContent } from '@/components/shell/sidebar';
import { Composer } from '@/features/chat/composer';
import { FounderMessage, LiveExchange, OpenerMessage, VeirMessage } from '@/features/chat/exchange';
import { VeirAnswer } from '@/features/chat/veir-answer';
import type { TurnStreamState } from '@/lib/api/hooks/turn-stream';
import type { TurnProgress } from '@/features/coach/progress';

import { AD_IDS, AD_ME, AD_RESPONSE, AD_SAVED, AD_SESSION, AD_TENANT, AD_TURN, AD_VENTURE } from './fixtures';
import type { Frame } from './script';

const noop = () => undefined;
const PERSONA = AD_VENTURE.persona?.name ?? '';

/**
 * Finished progress: the live exchange shows no progress line (whose step announcements would reach the page's
 * live region), only the streamed words.
 */
const QUIET_PROGRESS: TurnProgress = {
  outcome: 'completed',
  steps: (['understanding', 'retrieving', 'reasoning', 'checking'] as const).map((id) => ({
    id,
    status: 'done',
    evidenceCount: null,
  })),
};

function streamState(frame: Frame): TurnStreamState {
  return {
    status: 'streaming',
    pendingText: AD_SESSION.question,
    turnId: AD_IDS.turn,
    ordinal: 1,
    phase: 'reasoning',
    steps: [],
    turn: null,
    blocked: null,
    error: null,
    autoRetryAt: null,
    units: frame.streamed ? [{ seq: 0, text: frame.streamed }] : [],
    streamedText: frame.streamed,
  };
}

/**
 * The laptop's screen: the app's own side panel and conversation, rendered by the real components from the
 * synthetic venture. The question is typed into the real composer, the answer streams through the real live
 * exchange, and the stored answer replaces it as it does in the app, with its evidence and next step; the
 * decision the call settles then shows as saved to Knowledge.
 */
export function LaptopScreen({ frame }: { frame: Frame }) {
  const nextActions = useMemo(() => ({ saved: new Set<number>(), savingIndex: null, onAdd: noop }), []);
  const escalation = useMemo(() => ({ existing: null }), []);
  const saved = frame.saved ? { tenant: AD_TENANT, ventureId: AD_IDS.venture, memories: AD_SAVED } : null;
  return (
    <div className="ad-app">
      <aside className="ad-panel">
        <SidebarContent
          me={AD_ME}
          workspace={{ kind: 'venture', ventureId: AD_IDS.venture }}
          onOpenSearch={noop}
          onOpenShortcuts={noop}
          onOpenDataUse={noop}
          onOpenReportProblem={noop}
        />
      </aside>
      <div className="ad-main">
        <div className="@container/conv flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="mx-auto grid w-full max-w-(--content-width) content-start gap-8 px-6 pt-14">
            <OpenerMessage text={AD_SESSION.opener} personaName={PERSONA} />
            {frame.chat === 'streaming' ? (
              <LiveExchange
                state={streamState(frame)}
                progress={QUIET_PROGRESS}
                author={AD_SESSION.founder}
                personaName={PERSONA}
                tenant={AD_TENANT}
                ventureId={AD_IDS.venture}
                canRetry={false}
                onRetry={noop}
                onEdit={noop}
              />
            ) : frame.chat === 'answered' ? (
              <article className="grid gap-6">
                <FounderMessage text={AD_SESSION.question} author={AD_SESSION.founder} at={null} />
                <VeirMessage personaName={PERSONA}>
                  <VeirAnswer
                    turn={AD_TURN}
                    response={AD_RESPONSE}
                    personaName={PERSONA}
                    latest
                    canEdit={false}
                    onOpenSource={noop}
                    onShowSources={noop}
                    nextActions={nextActions}
                    saved={saved}
                    escalation={escalation}
                  />
                </VeirMessage>
              </article>
            ) : null}
          </div>
        </div>
        <div className="mx-auto w-full max-w-(--content-width) px-6 pb-6">
          <Composer
            value={frame.draft}
            onChange={noop}
            personaName={PERSONA}
            mode="auto"
            onModeChange={noop}
            counterpart=""
            onCounterpartChange={noop}
            streaming={frame.chat === 'streaming'}
            disabledReason={null}
            onSend={noop}
            onStop={noop}
          />
        </div>
      </div>
    </div>
  );
}
