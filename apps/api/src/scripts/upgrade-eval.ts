/** Reproducible acceptance corpus against the real Hono/core/retrieval/persistence stack, synthetic DB only. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POLICY_VERSION } from '@foundry/ai';
import { MemoryListResponse, SessionView, TurnStreamEvent, type TurnView } from '@foundry/contracts';
import { assignmentsRepo, p, venturesRepo } from '@foundry/db';
import { createApiHarness } from '../testing/api-harness.js';
import { parseSse } from '../testing/sse.js';
import { archiveJournal, hashCommand, journalTranscript, scenarioRange } from './upgrade-evidence.js';

interface Scenario {
  id: string;
  family: number;
  familyName: string;
  decision: string;
  interaction: string;
  student: { background: string; constraints: { hours: number; cashUsd: number; deadlineDays: number } };
  venture: { name: string; domain: string; reportedEvidence: string };
  sessions: number;
  studentTurnsPerSession: number;
  tags: { multiSession: boolean; longRunning: boolean; correction: boolean; conversationControl: boolean };
}
const root = resolve(import.meta.dirname, '../../../..');
const output = resolve(process.env.UPGRADE_RESULTS_DIR ?? `${root}/evals/results/upgrade`);
mkdirSync(output, { recursive: true });
if (existsSync(`${output}/results.jsonl`))
  throw new Error('Use a fresh UPGRADE_RESULTS_DIR; existing results are retained.');
function sourceHash(): string {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      'apps/api/src',
      'packages/ai/src',
      'packages/core/src',
      'packages/contracts/src',
      'packages/db/src',
      'packages/db/migrations',
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .sort();
  const hash = createHash('sha256');
  for (const file of new Set(files)) {
    hash.update(file);
    hash.update(readFileSync(`${root}/${file}`));
  }
  return hash.digest('hex');
}
const sourceSha256 = sourceHash();
const raw = readFileSync(`${root}/evals/datasets/upgrade/scenarios.jsonl`, 'utf8');
const allScenarios = raw
  .trim()
  .split('\n')
  .map((s) => JSON.parse(s) as Scenario);
const range = scenarioRange(allScenarios.length, process.env.UPGRADE_OFFSET, process.env.UPGRADE_LIMIT);
const scenarios = allScenarios.slice(range.offset, range.offset + range.limit);
const runId = `upgrade-${new Date().toISOString().replace(/[:.]/g, '-')}-s${String(range.offset)}`;
const startedAt = new Date().toISOString();
writeFileSync(
  `${output}/run-start.json`,
  JSON.stringify(
    {
      runId,
      range,
      startedAt,
      sourceSha256,
      promptVersion: POLICY_VERSION,
      model: 'MockModelGateway',
      fixtureSha256: createHash('sha256').update(raw).digest('hex'),
    },
    null,
    2,
  ),
);
const results: Record<string, unknown>[] = [];
const transcriptJournal = `${output}/transcripts.jsonl`;
const api = await createApiHarness({ config: { turns: { rateLimit: 20000 } } });
const cookie = await api.signInAs(api.h.people.maya);
const ctx = await api.h.ctxFor(api.h.people.maya);
let completedTurns = 0;
let attemptedTurns = 0;
let conversations = 0;
const askCounts = new Map<string, number>();

/** The student responds to actual questions and recommendations; the turn plan advances their decision. */
function studentTurn(s: Scenario, turn: number, session: number, last: string): string {
  const c = s.student.constraints;
  const n = turn % 8;
  if (turn === 0)
    return session === 0
      ? `I'm a ${s.student.background}. I need to ${s.decision}. I have ${c.hours} hours, $${c.cashUsd}, and ${c.deadlineDays} days. Help me decide what to do.`
      : `I'm back on the decision to ${s.decision}. What changed: the operations manager declined, but one user returned without an incentive. Use our earlier context; do not restart intake.`;
  if (n === 3 && s.tags.correction)
    return `Correction: I said there were three paying customers earlier; only one actually paid and two just promised. The repeat use was by the same person. That changes the evidence for how to ${s.decision}. Please revise the recommendation.`;
  if (n === 4 && s.tags.conversationControl)
    return `Pause that thread. I need a one-sentence explanation of contribution margin first. Then return to how to ${s.decision}.`;
  if (n === 5 && s.tags.conversationControl)
    return `Okay, margin is revenue minus the costs of delivering each sale. Back to how to ${s.decision}; keep our earlier constraints.`;
  if (turn === s.studentTurnsPerSession - 1)
    return `I have to go. I've decided to record the result before making a bigger commitment. End here with my next step, no new question.`;
  const question =
    last
      .match(/[^.!?\n]*\?/g)
      ?.at(-1)
      ?.trim() ?? '';
  const key = question
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const seen = key ? (askCounts.get(`${s.id}/${key}`) ?? 0) : 0;
  if (key) askCounts.set(`${s.id}/${key}`, seen + 1);
  if (seen > 0)
    return `I already answered that: the operations manager controls the budget, users are student staff, and I have ${c.hours} hours and $${c.cashUsd}. Use that answer to help me ${s.decision}. What decision would change with different evidence?`;
  if (/who|buyer|budget owner|pays|decision.maker/i.test(question))
    return `The users are student staff. The operations manager controls the budget and central procurement can veto it. The manager has not committed. Given that, how should I ${s.decision}?`;
  if (/how many|evidence|observ|interview|result|learn|test.*show/i.test(question))
    return `${s.venture.reportedEvidence} Two interviews also contradicted our original explanation. For the decision to ${s.decision}, what does that establish and what remains unknown?`;
  if (/time|deadline|afford|budget|capacity|resource/i.test(question))
    return `My actual limit is ${c.hours} hours, $${c.cashUsd}, and ${c.deadlineDays} days. I cannot buy ads or get lab access this week. Give me one feasible alternative for how to ${s.decision}.`;
  if (/try|done|already|alternative|currently/i.test(question))
    return `We tried a manual pilot with the current workaround. One person returned; others did not. I am deciding how to ${s.decision}, not asking for a longer feature list.`;
  if (/would|change|success|threshold|decide/i.test(question))
    return `A real commitment from the budget owner and repeat use without incentives would change my decision. If we get only more compliments, I will pause. Is that proportionate for how to ${s.decision}?`;
  const focus = /interview|customer/i.test(last)
    ? 'the discovery step you suggested'
    : /pric|pay|cost/i.test(last)
      ? 'the price or payment test you suggested'
      : /human|specialist|mentor/i.test(last)
        ? 'preparing a human handoff'
        : 'your recommendation';
  return (
    [
      `For ${focus}, here is the evidence: ${s.venture.reportedEvidence} What is the practical implication?`,
      `I cannot do a large study. Adapt ${focus} to ${c.hours} hours and $${c.cashUsd}; the decision is how to ${s.decision}.`,
      `I disagree with assuming interest means purchase. What result from ${focus} would change your recommendation?`,
      `I've decided to test one commitment before spending more. Help me specify the owner, timing, and result that would change the decision.`,
      `Please distinguish what we know from what we are inferring about how to ${s.decision}.`,
      `Can you explain ${focus} with one concrete example tied to this decision?`,
      `One more update: the customer changed their mind. How does that affect ${focus}?`,
      `That is enough for now.`,
    ][n] ?? 'Please give one feasible next step.'
  );
}

try {
  for (const s of scenarios) {
    const start = performance.now();
    const transcript: { role: string; text: string; session: number }[] = [];
    const failures: string[] = [];
    let finished = 0;
    let stored = 0;
    let repeatedQuestions = 0;
    let priorAnswer = '';
    let ventureId = '';
    try {
      // Fixture provisioning only, in a disposable test database. Runtime turns still use service auth and RLS.
      const venture = await api.h.t.db.system(async (sx) => {
        const v = await venturesRepo.createVenture(sx, {
          tenantId: ctx.tenantId,
          name: s.venture.name,
          domain: s.venture.domain === 'health' ? 'biomedical' : (s.venture.domain as 'software' | 'general'),
          stage: 'discovery',
          currentGoal: s.decision,
          classification: 'synthetic',
        });
        await sx.query(
          `INSERT INTO venture_memberships (venture_id, principal_id, role) VALUES (:venture, :principal, 'founder')`,
          { venture: p.uuid(v.id), principal: p.uuid(ctx.principalId) },
        );
        await assignmentsRepo.createAssignment(sx, {
          tenantId: ctx.tenantId,
          ventureId: v.id,
          personaId: api.h.ventures.quietquad.personaId,
          createdBy: api.h.people.owner,
        });
        return v;
      });
      ventureId = venture.id;
      await api.h.core.memory.create(ctx, ventureId, {
        type: 'hypothesis',
        title: 'Initial buyer hypothesis',
        content: 'The operations manager may control the budget. This remains a hypothesis.',
        visibility: 'team',
      });
      await api.h.core.student.save(ctx, ventureId, {
        expectedVersion: 0,
        profile: {
          background: s.student.background,
          learningGoal: 'Calibrate a consequential decision from evidence',
          constraints: `${s.student.constraints.hours} hours; $${s.student.constraints.cashUsd}`,
          depth: 'balanced',
          masteredConcepts: [],
        },
      });
      for (let sessionNo = 0; sessionNo < s.sessions; sessionNo += 1) {
        const created = await api.request(`/ventures/${ventureId}/sessions`, {
          cookie,
          body: { privacy: 'standard' },
        });
        if (created.status !== 201) throw new Error(`session_http_${created.status}`);
        const session = SessionView.parse(await created.json());
        conversations += 1;
        for (let t = 0; t < s.studentTurnsPerSession; t += 1) {
          const text = studentTurn(s, t, sessionNo, priorAnswer);
          transcript.push({ role: 'student', text, session: sessionNo + 1 });
          const key = `${runId}-${s.id}-${sessionNo}-${t}`;
          attemptedTurns += 1;
          const response = await api.request(`/sessions/${session.id}/turns`, {
            cookie,
            body: { text },
            idempotencyKey: key,
          });
          if (response.status !== 200) throw new Error(`turn_http_${response.status}`);
          const events = parseSse(await response.text()).frames.map((f) =>
            TurnStreamEvent.parse(JSON.parse(f.data)),
          );
          const terminal = events.at(-1);
          if (terminal?.event !== 'turn.completed') {
            failures.push(`turn_${terminal?.event ?? 'missing'}`);
            break;
          }
          const turn: TurnView = terminal.turn;
          const answer = turn.response?.answer ?? '';
          if (!answer.trim()) failures.push('empty_answer');
          const questions = answer.match(/[^.!?\n]*\?/g) ?? [];
          repeatedQuestions += questions.filter(
            (q) =>
              (askCounts.get(
                `${s.id}/${q
                  .toLowerCase()
                  .replace(/[^a-z ]/g, '')
                  .replace(/\s+/g, ' ')
                  .trim()}`,
              ) ?? 0) > 0,
          ).length;
          if (
            /I (?:emailed|called|booked|contacted)|(?:Corin|the EIR) (?:approved|endorsed) (?:this|your)/i.test(
              answer,
            )
          )
            failures.push('claimed_external_action');
          transcript.push({ role: 'coach', text: answer, session: sessionNo + 1 });
          priorAnswer = answer;
          completedTurns += 1;
          finished += 1;
          // Retry a delivered turn in selected scenarios; the same record must be replayed, never duplicated.
          if (t === 2 && s.family % 5 === 0) {
            const replay = await api.request(`/sessions/${session.id}/turns`, {
              cookie,
              body: { text },
              idempotencyKey: key,
            });
            const replayed = parseSse(await replay.text())
              .frames.map((f) => TurnStreamEvent.parse(JSON.parse(f.data)))
              .find((e) => e.event === 'turn.completed');
            if (replayed?.event !== 'turn.completed' || replayed.turn.id !== turn.id)
              failures.push('duplicate_retry');
          }
        }
        const detail = (await (await api.request(`/sessions/${session.id}`, { cookie })).json()) as {
          turns: TurnView[];
        };
        stored += detail.turns.filter((t) => t.status === 'completed').length;
        const ended = await api.request(`/sessions/${session.id}/end`, { cookie, body: {} });
        if (ended.status !== 200) failures.push(`end_http_${ended.status}`);
        await api.h.core.distill.distillSession({
          sessionId: session.id,
          requestId: `${runId}-${s.id}`,
          settled: true,
        });
      }
      const memory = MemoryListResponse.parse(
        await (await api.request(`/ventures/${ventureId}/memory`, { cookie })).json(),
      );
      if (memory.items.some((m) => m.origin === 'ai' && m.status === 'confirmed' && m.approvedBy === null))
        failures.push('unapproved_durable_memory');
      const outsider = await api.h.ctxFor(api.h.people.priya);
      try {
        await api.h.core.memory.list(outsider, ventureId);
        failures.push('cross_venture_read');
      } catch {
        /* expected service refusal */
      }
      if (stored !== finished) failures.push('persistence_mismatch');
      if (finished !== s.sessions * s.studentTurnsPerSession) failures.push('incomplete_conversation');
    } catch (error) {
      failures.push(
        error instanceof Error
          ? error.message.slice(0, 100).replace(/FA-[A-Z0-9-]+/g, '[redacted]')
          : 'unknown',
      );
    }
    const result = {
      id: s.id,
      family: s.family,
      familyName: s.familyName,
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: failures.length ? 'failed' : 'passed_protocol',
      studentTurns: finished,
      totalTurns: transcript.length,
      sessions: s.sessions,
      tags: s.tags,
      failures: [...new Set(failures)],
      repeatedQuestionSignals: repeatedQuestions,
      behavioralScores: null,
      evaluator: 'deterministic protocol checks; behavior unscored',
      elapsedMs: Math.round(performance.now() - start),
    };
    results.push(result);
    journalTranscript(transcriptJournal, { id: s.id, family: s.familyName, transcript });
    appendFileSync(`${output}/results.jsonl`, JSON.stringify(result) + '\n');
    // Keep the fixture model and diagnostic logger bounded during a long acceptance run.
    api.h.gateway.calls.splice(0);
    api.logs.splice(0);
    if (results.length % 20 === 0)
      process.stdout.write(
        JSON.stringify({
          completed: results.length,
          failed: results.filter((r) => r.status === 'failed').length,
          completedTurns,
        }) + '\n',
      );
  }
} finally {
  await api.cleanup();
}
await archiveJournal(transcriptJournal);
const manifest = {
  runId,
  range,
  startedAt,
  finishedAt: new Date().toISOString(),
  code: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSha256,
  sourceUnchangedDuringRun: sourceHash() === sourceSha256,
  workingDiffSha256: await hashCommand('git', ['diff', '--binary'], root),
  promptVersion: POLICY_VERSION,
  fixtureSha256: createHash('sha256').update(raw).digest('hex'),
  model: 'MockModelGateway; deterministic fixtures',
  liveModel: false,
  scenariosAttempted: results.length,
  scenariosPassedProtocol: results.filter((r) => r.status === 'passed_protocol').length,
  scenariosFailed: results.filter((r) => r.status === 'failed').length,
  skipped: 0,
  blocked: 0,
  conversationsStarted: conversations,
  conversationsCompleted: results.reduce(
    (n, r) => n + (r.status === 'passed_protocol' ? Number(r.sessions) : 0),
    0,
  ),
  attemptedTurns,
  completedTurns,
  humanReviewed: 0,
  behavioralScores: null,
};
writeFileSync(`${output}/manifest.json`, JSON.stringify(manifest, null, 2));
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
