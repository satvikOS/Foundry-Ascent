import type { Doctrine, PersonaReleaseView, Style } from '@foundry/contracts';
import {
  BookOpen,
  Ban,
  CircleHelp,
  GraduationCap,
  MessageSquareText,
  Route,
  Scale,
  Siren,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { MODE_LABELS } from '@/lib/labels';

import { STYLE_OPTIONS, styleLabel } from './persona-labels';

function Section({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function Bullets({ items, empty = 'None specified.' }: { items: readonly string[]; empty?: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="grid list-disc gap-1 pl-5 text-sm">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** Persona doctrine as readable prose and lists (never raw JSON). */
export function DoctrineView({ doctrine }: { doctrine: Doctrine }) {
  return (
    <div className="grid gap-6">
      <p className="text-sm leading-6">{doctrine.summary}</p>

      <Section title="Frameworks" icon={BookOpen}>
        {doctrine.frameworks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No frameworks specified.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {doctrine.frameworks.map((framework, i) => (
              <li key={i} className="grid content-start gap-1.5 rounded-lg border border-border px-3.5 py-3">
                <p className="text-sm font-semibold">{framework.name}</p>
                <p className="text-[13px] text-muted-foreground">
                  <span className="font-medium text-foreground">When: </span>
                  {framework.whenToUse}
                </p>
                {framework.keyQuestions.length > 0 ? (
                  <ul className="grid list-disc gap-0.5 pl-4 text-[13px]">
                    {framework.keyQuestions.map((q, j) => (
                      <li key={j}>{q}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Evidence standard" icon={Scale}>
        <p className="text-sm">{doctrine.evidenceStandard}</p>
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title="Typical questions" icon={CircleHelp}>
          <Bullets items={doctrine.typicalQuestions} />
        </Section>
        <Section title="Teaching principles" icon={GraduationCap}>
          <Bullets items={doctrine.teachingPrinciples} />
        </Section>
        <Section title="Red lines" icon={Ban}>
          <Bullets items={doctrine.redLines} empty="No red lines — every release should have some." />
        </Section>
        <Section title="Escalation topics" icon={Siren}>
          <Bullets items={doctrine.escalationTopics} />
        </Section>
        <Section title="Referral destinations" icon={Route}>
          <Bullets items={doctrine.referralDestinations} />
        </Section>
      </div>
    </div>
  );
}

function Scale3<K extends 'directness' | 'warmth' | 'pace'>({
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
    <div className="grid gap-1.5 rounded-lg border border-border px-3.5 py-3">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="grid gap-1.5">
        <span className="text-sm font-semibold">{styleLabel(name, value)}</span>
        <span aria-hidden className="flex gap-1">
          {options.map((o) => (
            <span
              key={o.value}
              className={
                o.value === value
                  ? 'h-1.5 flex-1 rounded-full bg-foreground'
                  : 'h-1.5 flex-1 rounded-full bg-border-strong'
              }
            />
          ))}
        </span>
        {current ? <span className="text-xs text-muted-foreground">{current.description}</span> : null}
      </dd>
    </div>
  );
}

/** Persona style: the three dials, vocabulary, feedback structure and things to avoid. */
export function StyleView({ style }: { style: Style }) {
  return (
    <div className="grid gap-6">
      <dl className="grid gap-3 sm:grid-cols-3">
        <Scale3 name="directness" label="Directness" value={style.directness} />
        <Scale3 name="warmth" label="Warmth" value={style.warmth} />
        <Scale3 name="pace" label="Pace" value={style.pace} />
      </dl>
      <Section title="Feedback structure" icon={MessageSquareText}>
        <p className="text-sm whitespace-pre-wrap">{style.feedbackStructure}</p>
      </Section>
      <div className="grid gap-6 md:grid-cols-2">
        <Section title="Vocabulary" icon={BookOpen}>
          {style.vocabulary.length === 0 ? (
            <p className="text-sm text-muted-foreground">None specified.</p>
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
        <Section title="Avoid" icon={Ban}>
          <Bullets items={style.avoid} />
        </Section>
      </div>
    </div>
  );
}

/** Disclosure text and allowed coaching modes of a release. */
export function ReleaseGuardrails({
  release,
}: {
  release: Pick<PersonaReleaseView, 'disclosureText' | 'allowedModes'>;
}) {
  return (
    <div className="grid gap-6">
      <Section title="Disclosure shown to founders" icon={MessageSquareText}>
        <blockquote className="rounded-lg border border-dashed border-border-strong bg-muted/50 px-4 py-3 text-sm">
          {release.disclosureText}
        </blockquote>
      </Section>
      <Section title="Allowed coaching modes" icon={GraduationCap}>
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
