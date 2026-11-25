import type { VenturePath } from '@foundry/contracts';
import type { ReactNode } from 'react';

import { DisclosureBanner } from '@/components/disclosure-banner';

import { dueState, longDay } from './due';
import {
  ARC_LABELS,
  CRITERION_LABELS,
  currentStage,
  laterItems,
  nextSteps,
  planSources,
  planStory,
  stageLine,
} from './plan';
import './plan-sheet.css';
import { citationLabel } from './sources';

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="plan-block">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/**
 * The one-page plan, for paper or a PDF (a professor or an EIR reads it): where the venture is and what that stage asks
 * for, the step now, what follows, what is done, and the story. Only printed; the page on screen has the same content.
 */
export function PlanSheet({
  path,
  ventureName,
  disclosure,
}: {
  path: VenturePath;
  ventureName: string;
  disclosure: string;
}) {
  const stage = currentStage(path);
  const next = nextSteps(path);
  const later = laterItems(path);
  const sources = planSources(path);
  const entries = planStory(path.arc);
  const due = path.now ? dueState(path.now.dueOn) : null;
  // One page: a long how-to stays on screen and the steps themselves are printed.
  const how = (path.now?.items ?? []).reduce((total, item) => total + item.how.length, 0) <= 600;
  return (
    <div data-slot="plan-sheet" className="plan-sheet hidden print:block">
      <header className="plan-head">
        <p className="plan-title">{ventureName}: plan</p>
        <p>{longDay(new Date().toISOString())}</p>
      </header>
      <div className="plan-columns">
        <div>
          <Block title={stageLine(path)}>
            {stage ? <p>{stage.goal}</p> : null}
            <ul>
              {(stage?.criteria ?? []).map((criterion) => (
                <li key={criterion.id}>
                  <strong>{CRITERION_LABELS[criterion.status]}:</strong> {criterion.title}.{' '}
                  {criterion.evidence}
                </li>
              ))}
            </ul>
          </Block>
          {path.now ? (
            <Block title={due ? `Now (${due.text})` : 'Now'}>
              <p>
                <strong>{path.now.title}</strong>
              </p>
              <ol>
                {path.now.items.map((item, index) => (
                  <li key={`${String(index)}-${item.do}`}>
                    {item.done ? '☑' : '☐'} {item.do}
                    {how && item.how ? <span className="plan-quiet"> {item.how}</span> : null}
                  </li>
                ))}
              </ol>
              <p>
                <strong>Done when:</strong> {path.now.doneWhen}
              </p>
            </Block>
          ) : null}
          {next.length > 0 ? (
            <Block title="Next">
              <ul>
                {next.map((step) => {
                  const when = dueState(step.dueOn);
                  return (
                    <li key={step.id}>
                      {step.title}
                      {when ? <span className="plan-quiet"> ({when.text})</span> : null}
                    </li>
                  );
                })}
              </ul>
            </Block>
          ) : null}
          {later.length > 0 ? (
            <Block title="Later">
              <ul>
                {later.slice(0, 6).map((item) => (
                  <li key={item.id}>{item.title}</li>
                ))}
              </ul>
            </Block>
          ) : null}
        </div>
        <div>
          {path.done.length > 0 ? (
            <Block title="Done">
              <ul>
                {path.done.slice(0, 8).map((step) => (
                  <li key={step.id}>
                    {step.title}
                    {step.evidence ? <span className="plan-quiet"> {step.evidence}</span> : null}
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
          {entries.length > 0 ? (
            <Block title="Story">
              <ul>
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <strong>
                      {longDay(entry.on)} · {ARC_LABELS[entry.kind]}:
                    </strong>{' '}
                    {entry.title}
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
          {sources.length > 0 ? (
            <Block title="Sources">
              <ul>
                {sources.map((source) => (
                  <li key={citationLabel(source)}>
                    {citationLabel(source)}
                    {source.authors ? <span className="plan-quiet"> {source.authors}</span> : null}
                  </li>
                ))}
              </ul>
            </Block>
          ) : null}
        </div>
      </div>
      <DisclosureBanner variant="print" text={disclosure} className="plan-disclosure" />
    </div>
  );
}
