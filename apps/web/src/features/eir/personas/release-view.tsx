import type { Doctrine, PersonaReleaseView, Style } from '@foundry/contracts';
import { useId, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { MODE_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { STYLE_OPTIONS, styleLabel } from './persona-labels';

type HeadingLevel = 2 | 3;
type SubLevel = 3 | 4;

function Section({ title, level, children }: { title: string; level: SubLevel; children: ReactNode }) {
  const Heading = `h${level}` as const;
  return (
    <section className="grid content-start gap-2">
      <Heading className="text-small font-semibold">{title}</Heading>
      {children}
    </section>
  );
}

function Bullets({ items, empty = 'None.' }: { items: readonly string[]; empty?: string }) {
  if (items.length === 0) return <p className="text-small text-muted-foreground">{empty}</p>;
  return (
    <ul className="grid list-disc gap-1 pl-5 text-small">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** A persona's doctrine as readable prose and lists (never raw JSON). */
function DoctrineView({ doctrine, level = 3 }: { doctrine: Doctrine; level?: SubLevel }) {
  return (
    <div className="grid gap-8">
      <p className="prose-reading">{doctrine.summary}</p>

      <Section title="Frameworks" level={level}>
        {doctrine.frameworks.length === 0 ? (
          <p className="text-small text-muted-foreground">None.</p>
        ) : (
          <ol className="divide-y divide-border border-y border-border">
            {doctrine.frameworks.map((framework, i) => (
              <li key={i} className="grid gap-1 py-3.5">
                <p className="text-body font-medium">{framework.name}</p>
                <p className="text-small text-muted-foreground">{framework.whenToUse}</p>
                {framework.keyQuestions.length > 0 ? (
                  <ul className="mt-1 grid list-disc gap-0.5 pl-5 text-small">
                    {framework.keyQuestions.map((q, j) => (
                      <li key={j}>{q}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Evidence standard" level={level}>
        <p className="text-small">{doctrine.evidenceStandard}</p>
      </Section>

      <div className="grid gap-8 md:grid-cols-2">
        <Section title="Typical questions" level={level}>
          <Bullets items={doctrine.typicalQuestions} />
        </Section>
        <Section title="Teaching principles" level={level}>
          <Bullets items={doctrine.teachingPrinciples} />
        </Section>
        <Section title="Red lines" level={level}>
          <Bullets items={doctrine.redLines} />
        </Section>
        <Section title="Escalation topics" level={level}>
          <Bullets items={doctrine.escalationTopics} />
        </Section>
        <Section title="Referral destinations" level={level}>
          <Bullets items={doctrine.referralDestinations} />
        </Section>
      </div>
    </div>
  );
}

function Dial<K extends 'directness' | 'warmth' | 'pace'>({
  name,
  label,
  value,
}: {
  name: K;
  label: string;
  value: Style[K];
}) {
  const options: readonly { value: string; label: string; description: string }[] = STYLE_OPTIONS[name];
  const current = options.find((o) => o.value === value);
  return (
    <div className="grid content-start gap-1.5">
      <dt className="label-mono">{label}</dt>
      <dd className="grid gap-1.5">
        <span className="text-body font-medium">{styleLabel(name, value)}</span>
        <span aria-hidden className="flex max-w-40 gap-1">
          {options.map((o) => (
            <span
              key={o.value}
              className={cn(
                'h-1 flex-1 rounded-full',
                o.value === value ? 'bg-foreground' : 'bg-border-strong',
              )}
            />
          ))}
        </span>
        {current ? <span className="text-caption text-muted-foreground">{current.description}</span> : null}
      </dd>
    </div>
  );
}

/** A persona's style: the three dials, feedback structure, vocabulary and things to avoid. */
function StyleView({ style, level = 3 }: { style: Style; level?: SubLevel }) {
  return (
    <div className="grid gap-8">
      <dl className="grid gap-6 sm:grid-cols-3">
        <Dial name="directness" label="Directness" value={style.directness} />
        <Dial name="warmth" label="Warmth" value={style.warmth} />
        <Dial name="pace" label="Pace" value={style.pace} />
      </dl>
      <Section title="Feedback structure" level={level}>
        <p className="text-small whitespace-pre-wrap">{style.feedbackStructure}</p>
      </Section>
      <div className="grid gap-8 md:grid-cols-2">
        <Section title="Vocabulary" level={level}>
          {style.vocabulary.length === 0 ? (
            <p className="text-small text-muted-foreground">None.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {style.vocabulary.map((word, i) => (
                <li key={i}>
                  <Badge variant="secondary">{word}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Avoid" level={level}>
          <Bullets items={style.avoid} />
        </Section>
      </div>
    </div>
  );
}

/** The disclosure founders see and the coaching modes a release allows. */
export function ReleaseGuardrails({
  release,
  level = 3,
}: {
  release: Pick<PersonaReleaseView, 'disclosureText' | 'allowedModes'>;
  level?: SubLevel;
}) {
  return (
    <div className="grid gap-8">
      <Section title="Disclosure shown to founders" level={level}>
        <blockquote className="max-w-[68ch] rounded-lg border border-dashed border-border-strong px-4 py-3 text-small">
          {release.disclosureText}
        </blockquote>
      </Section>
      <Section title="Allowed modes" level={level}>
        <ul className="flex flex-wrap gap-1.5">
          {release.allowedModes.map((mode) => {
            const def = MODE_LABELS[mode];
            const Icon = def.icon;
            return (
              <li key={mode}>
                <Badge variant="outline" title={def.description}>
                  <Icon aria-hidden />
                  {def.label}
                </Badge>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

/** One release in full: doctrine, style, then disclosure and modes, as stacked sections. */
export function ReleaseContent({
  release,
  headingLevel = 2,
}: {
  release: PersonaReleaseView;
  headingLevel?: HeadingLevel;
}) {
  const ids = { doctrine: useId(), style: useId(), guardrails: useId() };
  const Heading = `h${headingLevel}` as const;
  const sub: SubLevel = headingLevel === 2 ? 3 : 4;
  const heading = 'font-serif text-subheading font-normal';
  return (
    <div className="grid max-w-3xl gap-12">
      <section aria-labelledby={ids.doctrine} className="grid gap-5">
        <Heading id={ids.doctrine} className={heading}>
          Doctrine
        </Heading>
        <DoctrineView doctrine={release.doctrine} level={sub} />
      </section>
      <section aria-labelledby={ids.style} className="grid gap-5">
        <Heading id={ids.style} className={heading}>
          Style
        </Heading>
        <StyleView style={release.style} level={sub} />
      </section>
      <section aria-labelledby={ids.guardrails} className="grid gap-5">
        <Heading id={ids.guardrails} className={heading}>
          Disclosure &amp; modes
        </Heading>
        <ReleaseGuardrails release={release} level={sub} />
      </section>
    </div>
  );
}
