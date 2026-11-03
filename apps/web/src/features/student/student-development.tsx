import {
  LearningLogResponse,
  LearningReflection,
  LearningReflectionInput,
  StudentProfileData,
  StudentProfileResponse,
} from '@foundry/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { api, createIdempotencyKey, path } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query-keys';

/** Separate student profile and reflection log; only explicit student submissions persist. */
export function StudentDevelopment({ ventureId }: { ventureId: string }) {
  const id = useId();
  const client = useQueryClient();
  const profileKey = queryKeys.venture.studentProfile(ventureId);
  const logKey = queryKeys.venture.learningLog(ventureId);
  const profile = useQuery({
    queryKey: profileKey,
    queryFn: ({ signal }) =>
      api.get(path`/ventures/${ventureId}/student-profile`, StudentProfileResponse, { signal }),
  });
  const log = useQuery({
    queryKey: logKey,
    queryFn: ({ signal }) =>
      api.get(path`/ventures/${ventureId}/learning-log`, LearningLogResponse, { signal }),
  });
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
    const blob = new Blob(
      [
        JSON.stringify(
          {
            profile: profile.data?.profile ?? null,
            learningLog: log.data?.items ?? [],
            exportedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'foundry-learning.json';
    link.click();
    URL.revokeObjectURL(url);
  };
  const error = save.error ?? clear.error ?? record.error ?? remove.error;
  return (
    <section className="grid gap-4 border-t pt-6" aria-labelledby={`${id}-heading`}>
      <div>
        <h2 id={`${id}-heading`} className="text-subheading font-medium">
          Your development
        </h2>
        <p className="mt-1 text-small text-muted-foreground">
          Your coaching profile and learning log belong to you in this venture.
        </p>
      </div>
      {profile.isError ? (
        <ErrorState error={profile.error} onRetry={() => void profile.refetch()} size="sm" headingLevel={3} />
      ) : null}
      <details className="rounded-xl border bg-card px-4">
        <summary className="min-h-11 cursor-pointer py-3 text-small font-medium">Coaching profile</summary>
        <form
          className="grid gap-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <fieldset
            className="contents"
            disabled={save.isPending || clear.isPending || profile.isPending || profile.isError}
          >
            <p className="text-caption text-muted-foreground">
              Only what you approve here shapes your coach’s explanations. Replies in shared venture
              conversations can reflect this context. No personal or sensitive details are needed.
            </p>
            {(['background', 'learningGoal', 'constraints'] as const).map((field) => (
              <label key={field} className="grid gap-1.5 text-small" htmlFor={`${id}-${field}`}>
                {field === 'background'
                  ? 'Relevant experience'
                  : field === 'learningGoal'
                    ? 'What you want to learn'
                    : 'Time, budget, or access constraints'}
                <Input
                  id={`${id}-${field}`}
                  value={draft[field]}
                  maxLength={field === 'background' ? 240 : 400}
                  onChange={(event) => {
                    setDirty(true);
                    setDraft({ ...draft, [field]: event.target.value });
                  }}
                />
              </label>
            ))}
            <label className="grid gap-1.5 text-small" htmlFor={`${id}-depth`}>
              Explanation depth
              <select
                id={`${id}-depth`}
                value={draft.depth}
                className="min-h-11 rounded-md border border-input bg-background px-3"
                onChange={(event) => {
                  setDirty(true);
                  setDraft({ ...draft, depth: event.target.value as StudentProfileData['depth'] });
                }}
              >
                <option value="concise">Concise</option>
                <option value="balanced">Balanced</option>
                <option value="detailed">Detailed</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-small" htmlFor={`${id}-mastered`}>
              Concepts you already understand
              <Input
                id={`${id}-mastered`}
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
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={save.isPending || profile.isPending || !dirty}>
                Approve profile
              </Button>
              {profile.data?.profile ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirmClear(true);
                  }}
                >
                  Clear profile
                </Button>
              ) : null}
            </div>
            {confirmClear ? (
              <div className="flex flex-wrap items-center gap-3 text-small">
                <p>Clear this venture’s coaching profile?</p>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={clear.isPending}
                  onClick={() => {
                    clear.mutate();
                  }}
                >
                  Confirm clear
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirmClear(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : null}
          </fieldset>
        </form>
      </details>
      <details className="rounded-xl border bg-card px-4">
        <summary className="min-h-11 cursor-pointer py-3 text-small font-medium">Learning log</summary>
        <div className="grid gap-5 pb-4">
          <p className="text-caption text-muted-foreground">
            Record how evidence changed your judgment. These are your reflections, separate from the venture’s
            facts and session history.
          </p>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              record.mutate();
            }}
          >
            <fieldset className="contents" disabled={record.isPending}>
              {(['decision', 'evidence', 'changedThinking', 'nextTest'] as const).map((field) => (
                <label key={field} className="grid gap-1.5 text-small" htmlFor={`${id}-reflection-${field}`}>
                  {field === 'decision'
                    ? 'Decision you faced'
                    : field === 'evidence'
                      ? 'Evidence you used'
                      : field === 'changedThinking'
                        ? 'What changed your thinking'
                        : 'Your next test (optional)'}
                  <Textarea
                    id={`${id}-reflection-${field}`}
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
                </label>
              ))}
              <Button size="sm" type="submit" className="justify-self-start" disabled={record.isPending}>
                Record reflection
              </Button>
            </fieldset>
          </form>
          {log.isError ? (
            <ErrorState error={log.error} onRetry={() => void log.refetch()} size="sm" headingLevel={3} />
          ) : (
            <ul className="divide-y" aria-label="Your learning reflections">
              {(log.data?.items ?? []).map((item) => (
                <li key={item.id} className="py-3">
                  <p className="text-small font-medium">{item.decision}</p>
                  <p className="mt-1 text-small text-muted-foreground">{item.changedThinking}</p>
                  <Button
                    size="xs"
                    variant="ghost"
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
          )}
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={exportData}
          disabled={profile.isPending || log.isPending || profile.isError || log.isError}
        >
          Export learning
        </Button>
        <span role="status" className="text-small text-muted-foreground">
          {notice}
        </span>
      </div>
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
    </section>
  );
}
