import {
  LearningReflection,
  LearningReflectionInput,
  StudentProfileData,
  StudentProfileResponse,
} from '@foundry/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageSection } from '@/components/ui/page-section';
import { SelectField } from '@/components/ui/select-field';
import { Textarea } from '@/components/ui/textarea';
import { api, createIdempotencyKey, path } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query-keys';

import { downloadLearning, learningLogQueryOptions, studentProfileQueryOptions } from './learning';

const DEPTH_OPTIONS = [
  { value: 'concise', label: 'Concise' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'detailed', label: 'Detailed' },
] as const satisfies readonly { value: StudentProfileData['depth']; label: string }[];

/**
 * The student's own development in this venture (Knowledge → You): the coaching profile and the learning log,
 * kept apart from the venture's facts. Only explicit student submissions persist.
 */
export function StudentDevelopment({ ventureId }: { ventureId: string }) {
  const id = useId();
  const client = useQueryClient();
  const profileKey = queryKeys.venture.studentProfile(ventureId);
  const logKey = queryKeys.venture.learningLog(ventureId);
  const profile = useQuery(studentProfileQueryOptions(ventureId));
  const log = useQuery(learningLogQueryOptions(ventureId));
  const [draft, setDraft] = useState(() => StudentProfileData.parse({}));
  const [dirty, setDirty] = useState(false);
  const [baseVersion, setBaseVersion] = useState(0);
  const [masteredText, setMasteredText] = useState('');
  const reflectionKey = useRef(createIdempotencyKey());
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState('');
  const [reflection, setReflection] = useState({
    decision: '',
    evidence: '',
    changedThinking: '',
    nextTest: '',
  });
  useEffect(() => {
    if (!dirty) {
      const saved = StudentProfileData.parse(profile.data?.profile ?? {});
      setDraft(saved);
      setMasteredText(saved.masteredConcepts.join(', '));
      setBaseVersion(profile.data?.profile?.version ?? 0);
    }
  }, [profile.data, dirty]);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: profileKey });
    void client.invalidateQueries({ queryKey: logKey });
  };
  const save = useMutation({
    mutationFn: () =>
      api.patch(
        path`/ventures/${ventureId}/student-profile`,
        StudentProfileResponse,
        { expectedVersion: baseVersion, profile: draft },
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: (data) => {
      client.setQueryData(profileKey, data);
      setDirty(false);
      setNotice('Coaching profile approved.');
    },
  });
  const clear = useMutation({
    mutationFn: () =>
      api.delete(path`/ventures/${ventureId}/student-profile`, { idempotencyKey: createIdempotencyKey() }),
    onSuccess: () => {
      client.setQueryData(profileKey, { profile: null });
      setDirty(false);
      setConfirmClear(false);
      setNotice('Coaching profile cleared.');
    },
  });
  const record = useMutation({
    mutationFn: () =>
      api.post(
        path`/ventures/${ventureId}/learning-log`,
        LearningReflection,
        LearningReflectionInput.parse(reflection),
        { idempotencyKey: reflectionKey.current },
      ),
    onSuccess: () => {
      reflectionKey.current = createIdempotencyKey();
      setReflection({ decision: '', evidence: '', changedThinking: '', nextTest: '' });
      setNotice('Reflection recorded.');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (reflectionId: string) =>
      api.delete(path`/ventures/${ventureId}/learning-log/${reflectionId}`, {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: () => {
      setNotice('Reflection deleted.');
      refresh();
    },
  });
  const exportData = () => {
    downloadLearning(profile.data?.profile ?? null, log.data?.items ?? []);
  };
  const error = save.error ?? clear.error ?? record.error ?? remove.error;
  const exportButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={exportData}
      disabled={profile.isPending || log.isPending || profile.isError || log.isError}
    >
      <Download aria-hidden />
      Export learning
    </Button>
  );
  return (
    <div className="grid gap-10">
      <PageSection
        title="Coaching profile"
        description="Only what you approve here shapes your coach’s explanations. Replies in shared venture conversations can reflect it. No personal or sensitive details are needed."
        actions={exportButton}
      >
        {profile.isError ? (
          <ErrorState
            error={profile.error}
            onRetry={() => void profile.refetch()}
            size="sm"
            headingLevel={3}
          />
        ) : null}
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <fieldset
            className="contents"
            disabled={save.isPending || clear.isPending || profile.isPending || profile.isError}
          >
            <div className="grid gap-5 sm:grid-cols-2">
              {(['background', 'learningGoal'] as const).map((field) => (
                <Field
                  key={field}
                  id={`${id}-${field}`}
                  label={field === 'background' ? 'Relevant experience' : 'What you want to learn'}
                >
                  <Input
                    value={draft[field]}
                    maxLength={field === 'background' ? 240 : 400}
                    onChange={(event) => {
                      setDirty(true);
                      setDraft({ ...draft, [field]: event.target.value });
                    }}
                  />
                </Field>
              ))}
            </div>
            <Field id={`${id}-constraints`} label="Time, budget, or access constraints">
              <Input
                value={draft.constraints}
                maxLength={400}
                onChange={(event) => {
                  setDirty(true);
                  setDraft({ ...draft, constraints: event.target.value });
                }}
              />
            </Field>
            <div className="grid gap-5 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
              <SelectField
                label="Explanation depth"
                value={draft.depth}
                options={DEPTH_OPTIONS}
                onChange={(depth) => {
                  setDirty(true);
                  setDraft({ ...draft, depth });
                }}
              />
              <Field id={`${id}-mastered`} label="Concepts you already understand">
                <Input
                  value={masteredText}
                  placeholder="For example: discovery interviews, contribution margin"
                  maxLength={600}
                  onChange={(event) => {
                    setDirty(true);
                    setMasteredText(event.target.value);
                    setDraft({
                      ...draft,
                      masteredConcepts: event.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .slice(0, 12)
                        .map((s) => s.slice(0, 80)),
                    });
                  }}
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {profile.data?.profile && !confirmClear ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setConfirmClear(true);
                  }}
                >
                  Clear profile
                </Button>
              ) : null}
              {confirmClear ? (
                <>
                  <p className="mr-auto text-small">Clear this venture’s coaching profile?</p>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setConfirmClear(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={clear.isPending}
                    onClick={() => {
                      clear.mutate();
                    }}
                  >
                    Confirm clear
                  </Button>
                </>
              ) : null}
              <Button type="submit" disabled={save.isPending || profile.isPending || !dirty}>
                Approve profile
              </Button>
            </div>
          </fieldset>
        </form>
      </PageSection>

      <PageSection
        title="Learning log"
        description="Record how evidence changed your judgment. These are your reflections, separate from the venture’s facts and session history."
      >
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            record.mutate();
          }}
        >
          <fieldset className="contents" disabled={record.isPending}>
            <div className="grid gap-5 sm:grid-cols-2">
              {(['decision', 'evidence', 'changedThinking', 'nextTest'] as const).map((field) => (
                <Field
                  key={field}
                  id={`${id}-reflection-${field}`}
                  label={
                    field === 'decision'
                      ? 'Decision you faced'
                      : field === 'evidence'
                        ? 'Evidence you used'
                        : field === 'changedThinking'
                          ? 'What changed your thinking'
                          : 'Your next test (optional)'
                  }
                >
                  <Textarea
                    required={field !== 'nextTest'}
                    minLength={field === 'nextTest' ? undefined : 3}
                    maxLength={field === 'evidence' || field === 'changedThinking' ? 1000 : 400}
                    rows={2}
                    value={reflection[field]}
                    onChange={(event) => {
                      reflectionKey.current = createIdempotencyKey();
                      setReflection({ ...reflection, [field]: event.target.value });
                    }}
                  />
                </Field>
              ))}
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={record.isPending}>
                Record reflection
              </Button>
            </div>
          </fieldset>
        </form>
        {log.isError ? (
          <ErrorState error={log.error} onRetry={() => void log.refetch()} size="sm" headingLevel={3} />
        ) : (log.data?.items.length ?? 0) > 0 ? (
          <ul
            className="divide-y divide-border border-y border-border"
            aria-label="Your learning reflections"
          >
            {(log.data?.items ?? []).map((item) => (
              <li key={item.id} className="flex items-start gap-3 py-3">
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <p className="text-small font-medium">{item.decision}</p>
                  <p className="text-small text-muted-foreground">{item.changedThinking}</p>
                </div>
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={remove.isPending}
                  onClick={() => {
                    remove.mutate(item.id);
                  }}
                >
                  Delete reflection<span className="sr-only">: {item.decision}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </PageSection>

      <p role="status" className="-mt-6 text-small text-muted-foreground">
        {notice}
      </p>
      {error ? (
        <p role="alert" className="text-small text-destructive">
          {errorMessage(error)} Your draft is preserved.
          <Button
            size="sm"
            variant="link"
            onClick={() => {
              void profile.refetch().then((fresh) => {
                if (fresh.data) {
                  setDirty(false);
                  setNotice('Saved profile loaded.');
                }
              });
            }}
          >
            Reload profile
          </Button>
        </p>
      ) : null}
    </div>
  );
}
