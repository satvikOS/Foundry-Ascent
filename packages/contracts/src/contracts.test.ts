import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AbandonDocumentUploadResponse,
  AdminPrincipalRow,
  ApprovePersonaReleaseResponse,
  CompleteDocumentResponse,
  CreateDocumentResponse,
  CreateEscalationResponse,
  CreateMemoryResponse,
  CreatePersonaReleaseResponse,
  CreatePrincipalResponse,
  CreateProgramVentureResponse,
  CreateResourceResponse,
  CreateSessionResponse,
  CreateEirProfileRequest,
  CreateTurnRequest,
  DocumentView,
  EirProfileView,
  EvidenceItem,
  LessonListResponse,
  LessonQuery,
  UpdateEirProfileRequest,
  EscalationActionResponse,
  EscalationQueueItem,
  EscalationView,
  HealthResponse,
  MemoryActionResponse,
  MemoryObjectView,
  PersonaReleaseView,
  PersonaView,
  ProgramVentureRow,
  RenewDocumentUploadResponse,
  ResourceView,
  ResumePersonaResponse,
  RevokeAccessCodeResponse,
  RouteEscalationResponse,
  SessionView,
  SubmitReviewResponse,
  SuspendPersonaResponse,
  UpdatePrincipalRequest,
  UpdatePrincipalResponse,
  UpdateResourceResponse,
  CLOSED_ESCALATION_STATUSES,
  ERROR_STATUS,
  EscalationAssignee,
  EscalationAssigneeListResponse,
  EscalationStatus,
  OPEN_ESCALATION_STATUSES,
  PersonaReleaseDetailResponse,
  TurnStreamEvent,
  TurnView,
  ErrorCode,
  Me,
  MemoryQuery,
  RequestedRole,
  ResourceFilter,
  SignInResponse,
  TEST_TURN_MAX_HISTORY,
  TestTurnRequest,
  TestTurnResponse,
  UpdateResourceRequest,
} from './index.js';

const ID = '0b6f2c4e-1d3a-4c5b-9e7f-8a9b0c1d2e3f';

describe('MemoryQuery.pinned', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['off', false],
    [true, true],
    [false, false],
  ])('reads %j as %j', (input, expected) => {
    expect(MemoryQuery.parse({ pinned: input }).pinned).toBe(expected);
  });

  it('is optional', () => {
    expect(MemoryQuery.parse({}).pinned).toBeUndefined();
  });

  it('rejects text that is not a boolean flag (z.coerce.boolean would have read it as true)', () => {
    expect(MemoryQuery.safeParse({ pinned: 'maybe' }).success).toBe(false);
    expect(MemoryQuery.safeParse({ pinned: 'false ' }).success).toBe(true);
  });
});

describe('CreateTurnRequest', () => {
  it('still accepts the original shape (expectedOrdinal is optional)', () => {
    expect(CreateTurnRequest.parse({ text: '  What should we test first?  ' })).toEqual({
      text: 'What should we test first?',
    });
  });

  it('carries the expected ordinal for idempotent retries', () => {
    expect(CreateTurnRequest.parse({ text: 'hi', expectedOrdinal: 3 }).expectedOrdinal).toBe(3);
    expect(CreateTurnRequest.safeParse({ text: 'hi', expectedOrdinal: 0 }).success).toBe(false);
    expect(CreateTurnRequest.safeParse({ text: 'hi', expectedOrdinal: 1.5 }).success).toBe(false);
  });
});

describe('SignInResponse', () => {
  it('is the Me document', () => {
    const me = {
      principal: { id: ID, displayName: 'Maya', title: null, synthetic: true },
      tenant: { id: ID, slug: 'ain', name: 'Ain Foundry', kind: 'home' },
      roles: ['program_lead'],
      memberships: [{ ventureId: ID, ventureName: 'QuietQuad', role: 'founder' }],
      assignedVentureIds: [],
      disclosure: 'You are working with Foundry Guide, an AI coach.',
      aiEnabled: true,
    };
    const parsed = Me.safeParse(me);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(SignInResponse.parse(me)).toEqual(Me.parse(me));
    expectTypeOf<SignInResponse>().toEqualTypeOf<Me>();
  });
});

describe('UpdateResourceRequest', () => {
  it('accepts any subset of fields plus status, without applying defaults', () => {
    expect(UpdateResourceRequest.parse({ status: 'retired' })).toEqual({ status: 'retired' });
    expect(UpdateResourceRequest.parse({ name: ' Office hours ', url: null })).toEqual({
      name: 'Office hours',
      url: null,
    });
  });

  it('requires at least one field and validates each one', () => {
    expect(UpdateResourceRequest.safeParse({}).success).toBe(false);
    expect(UpdateResourceRequest.safeParse({ status: 'archived' }).success).toBe(false);
    expect(UpdateResourceRequest.safeParse({ url: 'not a url' }).success).toBe(false);
  });
});

describe('ResourceFilter', () => {
  it('trims text filters and validates enums', () => {
    expect(ResourceFilter.parse({ tag: ' ip ', q: ' patents ' })).toEqual({ tag: 'ip', q: 'patents' });
    expect(ResourceFilter.parse({})).toEqual({});
    expect(ResourceFilter.safeParse({ stage: 'unicorn' }).success).toBe(false);
  });
});

describe('error codes', () => {
  it('maps every code to an HTTP status', () => {
    for (const code of ErrorCode.options) expect(ERROR_STATUS[code], code).toBeGreaterThanOrEqual(400);
  });

  it('exports the RequestedRole type', () => {
    expectTypeOf<RequestedRole>().toEqualTypeOf<
      'eir' | 'program_lead' | 'specialist' | 'university_support'
    >();
    expect(RequestedRole.options).toContain('eir');
  });
});

describe('response schemas', () => {
  it('names the response schema of every write endpoint the web parses', () => {
    const pairs: [unknown, unknown][] = [
      [SignInResponse, Me],
      [CreateSessionResponse, SessionView],
      [CreateMemoryResponse, MemoryObjectView],
      [MemoryActionResponse, MemoryObjectView],
      [CompleteDocumentResponse, DocumentView],
      [AbandonDocumentUploadResponse, DocumentView],
      [RenewDocumentUploadResponse, CreateDocumentResponse],
      [CreateEscalationResponse, EscalationView],
      [EscalationActionResponse, EscalationView],
      [CreatePersonaReleaseResponse, PersonaReleaseView],
      [ApprovePersonaReleaseResponse, PersonaReleaseView],
      [SuspendPersonaResponse, PersonaView],
      [ResumePersonaResponse, PersonaView],
      [CreateResourceResponse, ResourceView],
      [UpdateResourceResponse, ResourceView],
      [CreateProgramVentureResponse, ProgramVentureRow],
      [CreatePrincipalResponse, AdminPrincipalRow],
      [UpdatePrincipalResponse, AdminPrincipalRow],
      [RouteEscalationResponse, EscalationQueueItem],
      [PersonaReleaseDetailResponse, PersonaReleaseView],
    ];
    for (const [response, view] of pairs) expect(response).toBe(view);
  });

  it('takes a principal’s video-face access as a boolean and nothing else', () => {
    expect(UpdatePrincipalRequest.parse({ faceAccess: true })).toEqual({ faceAccess: true });
    expect(UpdatePrincipalRequest.parse({ faceAccess: false, roles: ['platform_admin'] })).toEqual({
      faceAccess: false,
    });
    expect(UpdatePrincipalRequest.safeParse({}).success).toBe(false);
    expect(UpdatePrincipalRequest.safeParse({ faceAccess: 'yes' }).success).toBe(false);
  });

  it('parses the small acknowledgement bodies', () => {
    expect(SubmitReviewResponse.parse({ reviewId: ID, turnId: ID })).toEqual({ reviewId: ID, turnId: ID });
    expect(
      RevokeAccessCodeResponse.safeParse({ accessCodeId: ID, revokedAt: '2026-10-05T10:00:00.000Z' }).success,
    ).toBe(true);
  });

  it('accepts a liveness-only health body (no database probe) and a probed one', () => {
    const base = { status: 'ok', version: 'abc123', time: '2026-10-05T10:00:00.000Z' };
    expect(HealthResponse.parse(base)).toEqual(base);
    expect(HealthResponse.parse({ ...base, db: 'resuming' }).db).toBe('resuming');
    expect(HealthResponse.safeParse({ ...base, db: 'asleep' }).success).toBe(false);
  });
});

describe('escalation lifecycle', () => {
  it('has a distinct state for consented escalations waiting for routing', () => {
    expect(EscalationStatus.options).toEqual([
      'draft',
      'awaiting_consent',
      'awaiting_assignment',
      'routed',
      'acknowledged',
      'resolved',
      'declined',
      'withdrawn',
    ]);
    expectTypeOf<EscalationStatus>().toEqualTypeOf<(typeof EscalationStatus.options)[number]>();
  });

  it('splits every status into open or closed, exactly once', () => {
    const all = [...OPEN_ESCALATION_STATUSES, ...CLOSED_ESCALATION_STATUSES];
    expect([...all].sort()).toEqual([...EscalationStatus.options].sort());
    expect(OPEN_ESCALATION_STATUSES).toContain('awaiting_assignment');
  });

  it('lists routing assignees with EIR or program-lead roles only', () => {
    const principal = { id: ID, displayName: 'Ruth (synthetic)', title: null, synthetic: true };
    expect(
      EscalationAssigneeListResponse.parse({ items: [{ principal, roles: ['eir'], expertiseTags: ['ip'] }] })
        .items,
    ).toHaveLength(1);
    expect(EscalationAssignee.safeParse({ principal, roles: [], expertiseTags: [] }).success).toBe(false);
    expect(
      EscalationAssignee.safeParse({ principal, roles: ['platform_admin'], expertiseTags: [] }).success,
    ).toBe(false);
  });
});

describe('turn views and events (additive fields)', () => {
  const turn = {
    id: ID,
    sessionId: ID,
    ordinal: 1,
    mode: 'coach',
    founderText: 'hi',
    status: 'blocked',
    response: null,
    evidence: [],
    validator: null,
    usage: null,
    createdAt: '2026-10-05T10:00:00.000Z',
    completedAt: '2026-10-05T10:00:01.000Z',
  };

  it('reads a turn without `blocked` (an older API) as not blocked-described', () => {
    expect(TurnView.parse(turn).blocked).toBeNull();
  });

  it('carries the blocked reason, support message and escalation of a blocked turn', () => {
    const blocked = { reason: 'crisis_support', supportMessage: 'Call 988.', escalationId: ID };
    expect(TurnView.parse({ ...turn, blocked }).blocked).toEqual(blocked);
    expect(TurnView.safeParse({ ...turn, blocked: { reason: 'x' } }).success).toBe(false);
  });

  it('reads a turn without `author` or `myFeedback` (an older API) as unknown author and unrated', () => {
    const parsed = TurnView.parse(turn);
    expect(parsed.author).toBeNull();
    expect(parsed.myFeedback).toBeNull();
  });

  it('carries who wrote the turn and the viewer’s own rating', () => {
    const author = { id: ID, displayName: 'Devin Ashcombe' };
    const parsed = TurnView.parse({ ...turn, author, myFeedback: { rating: 5 } });
    expect(parsed.author).toEqual(author);
    expect(parsed.myFeedback).toEqual({ rating: 5 });
    expect(TurnView.safeParse({ ...turn, myFeedback: { rating: 6 } }).success).toBe(false);
    expect(TurnView.safeParse({ ...turn, author: { id: ID } }).success).toBe(false);
  });

  it('reads a conversation without `digestDeleted` (an older API) as not deleted', () => {
    const session = {
      id: ID,
      ventureId: ID,
      mode: 'coach',
      privacy: 'standard',
      goal: null,
      status: 'ended',
      personaName: "Corin's vEIR",
      personaVersion: 1,
      disclosure: 'AI',
      startedBy: { id: ID, displayName: 'Maya' },
      startedAt: '2026-10-05T10:00:00.000Z',
      endedAt: '2026-10-05T10:05:00.000Z',
      turnCount: 1,
      recap: null,
    };
    expect(SessionView.parse(session).digestDeleted).toBe(false);
    expect(SessionView.parse({ ...session, digestDeleted: true }).digestDeleted).toBe(true);
  });

  it('turn.error accepts the original shape and the new retryAfterSeconds and requestId', () => {
    const base = { event: 'turn.error', turnId: ID, code: 'conflict', message: 'm', retryable: true };
    expect(TurnStreamEvent.parse(base)).toEqual(base);
    expect(TurnStreamEvent.parse({ ...base, retryAfterSeconds: 5, requestId: 'req-1' })).toEqual({
      ...base,
      retryAfterSeconds: 5,
      requestId: 'req-1',
    });
    expect(TurnStreamEvent.safeParse({ ...base, retryAfterSeconds: 0 }).success).toBe(false);
    expect(TurnStreamEvent.safeParse({ ...base, retryAfterSeconds: 1.5 }).success).toBe(false);
  });
});

describe('evidence sources (additive)', () => {
  const item = {
    key: 'E2',
    kind: 'chunk',
    refId: ID,
    title: 'Interview notes.md — Week 1',
    excerpt: 'Students queue for seats.',
    score: 0.8,
    freshnessAt: null,
    status: 'active',
  };

  it('reads evidence without a source (an older API or a stored answer) as source unknown', () => {
    expect(EvidenceItem.parse(item).source).toBeUndefined();
    expect(EvidenceItem.parse({ ...item, source: null }).source).toBeNull();
  });

  it('carries the source of a passage by id and scope', () => {
    for (const scope of ['venture', 'program', 'public', 'persona'] as const) {
      expect(EvidenceItem.parse({ ...item, source: { id: ID, scope } }).source).toEqual({ id: ID, scope });
    }
    expect(EvidenceItem.safeParse({ ...item, source: { id: ID, scope: 'elsewhere' } }).success).toBe(false);
    expect(EvidenceItem.safeParse({ ...item, source: { id: 'not-an-id', scope: 'venture' } }).success).toBe(
      false,
    );
  });

  it('gives a document its knowledge source id, absent from older APIs', () => {
    const document = {
      id: ID,
      ventureId: ID,
      filename: 'Interview notes.md',
      contentType: 'text/markdown',
      sizeBytes: 10,
      status: 'ready',
      failureReason: null,
      uploadedBy: { id: ID, displayName: 'Maya', title: null, synthetic: true },
      createdAt: '2026-10-05T10:00:00.000Z',
      chunkCount: 3,
    };
    expect(DocumentView.parse(document).sourceId).toBeUndefined();
    expect(DocumentView.parse({ ...document, sourceId: ID }).sourceId).toBe(ID);
  });
});

describe('EIR profiles', () => {
  it('normalises expertise to hyphenated lower-case areas, once each, and empty text to none', () => {
    const parsed = CreateEirProfileRequest.parse({
      principalId: ID,
      displayName: '  Noor Haddad ',
      title: '  ',
      expertiseTags: ['Climate Tech', 'climate-tech', ' B2B  sales '],
      bio: '',
    });
    expect(parsed).toEqual({
      principalId: ID,
      displayName: 'Noor Haddad',
      title: null,
      expertiseTags: ['climate-tech', 'b2b-sales'],
      bio: null,
    });
    // Parsing the result again (the API parses, then core does) changes nothing.
    expect(CreateEirProfileRequest.parse(parsed)).toEqual(parsed);
    expect(CreateEirProfileRequest.parse({ principalId: ID, displayName: 'Noor Haddad' })).toMatchObject({
      title: null,
      expertiseTags: [],
      bio: null,
    });
  });

  it('refuses what a profile cannot hold, at the field', () => {
    const paths = (value: unknown) =>
      (CreateEirProfileRequest.safeParse(value).error?.issues ?? []).map((i) => i.path.join('.'));
    expect(paths({ principalId: 'x', displayName: 'Noor' })).toEqual(['principalId']);
    expect(paths({ principalId: ID, displayName: ' ' })).toEqual(['displayName']);
    expect(paths({ principalId: ID, displayName: 'Noor', bio: 'x'.repeat(2001) })).toEqual(['bio']);
    expect(paths({ principalId: ID, displayName: 'Noor', expertiseTags: ['a'] })).toEqual([
      'expertiseTags.0',
    ]);
    const thirteen = Array.from({ length: 13 }, (_, i) => `area-${i}`);
    expect(paths({ principalId: ID, displayName: 'Noor', expertiseTags: thirteen })).toEqual([
      'expertiseTags',
    ]);
  });

  it('edits at least one field; clearing the title or bio is an edit', () => {
    expect(UpdateEirProfileRequest.safeParse({}).success).toBe(false);
    expect(UpdateEirProfileRequest.parse({ bio: '' })).toEqual({ bio: null });
    expect(UpdateEirProfileRequest.parse({ title: null })).toEqual({ title: null });
  });

  it('reads a profile without bio or account (an older API)', () => {
    const profile = {
      id: ID,
      displayName: 'Corin Halvorsen',
      title: null,
      expertiseTags: [],
      routingIntents: [],
      synthetic: true,
      status: 'active',
    };
    expect(EirProfileView.parse(profile)).toEqual(profile);
    const account = { id: ID, displayName: 'Corin Halvorsen', title: null, synthetic: true };
    expect(EirProfileView.parse({ ...profile, bio: null, principal: account }).principal).toEqual(account);
  });
});

describe('LessonQuery', () => {
  it('reads one or more states, comma-separated, once each', () => {
    expect(LessonQuery.parse({ status: 'draft' })).toEqual({ status: ['draft'] });
    expect(LessonQuery.parse({ status: ' draft, in_review,draft ' })).toEqual({
      status: ['draft', 'in_review'],
    });
    expect(LessonQuery.parse({})).toEqual({});
    // The parsed form parses again unchanged (the API parses, then core does).
    expect(LessonQuery.parse(LessonQuery.parse({ status: 'draft,in_review' }))).toEqual({
      status: ['draft', 'in_review'],
    });
  });

  it('refuses unknown states and an empty list', () => {
    expect(LessonQuery.safeParse({ status: 'drafts' }).success).toBe(false);
    expect(LessonQuery.safeParse({ status: ',' }).success).toBe(false);
    expect(LessonQuery.safeParse({ status: [] }).success).toBe(false);
  });

  it('carries how many lessons match, absent elsewhere', () => {
    expect(LessonListResponse.parse({ items: [] }).total).toBeUndefined();
    expect(LessonListResponse.parse({ items: [], total: 3 }).total).toBe(3);
  });
});

describe('test bench (EIR studio)', () => {
  it('carries one message, the release and at most a few earlier exchanges; nothing else', () => {
    const parsed = TestTurnRequest.parse({ releaseId: ID, text: '  How should I price this?  ' });
    expect(parsed).toEqual({ releaseId: ID, text: 'How should I price this?', history: [] });
    const exchange = { text: 'Hi', answer: 'Hello.' };
    expect(
      TestTurnRequest.safeParse({
        releaseId: ID,
        text: 'x',
        history: Array.from({ length: TEST_TURN_MAX_HISTORY }, () => exchange),
      }).success,
    ).toBe(true);
    expect(
      TestTurnRequest.safeParse({
        releaseId: ID,
        text: 'x',
        history: Array.from({ length: TEST_TURN_MAX_HISTORY + 1 }, () => exchange),
      }).success,
    ).toBe(false);
    expect(TestTurnRequest.safeParse({ releaseId: ID, text: '   ' }).success).toBe(false);
    expect(TestTurnRequest.safeParse({ releaseId: 'nope', text: 'x' }).success).toBe(false);
    expect(TestTurnRequest.safeParse({ releaseId: ID, text: 'x'.repeat(8001) }).success).toBe(false);
  });

  it('answers with the release tried, the validated response or the block, and what the checks did', () => {
    const validator = {
      unknownEvidenceIdsRemoved: 0,
      factsDowngraded: 0,
      groundingCoverage: null,
      narrowed: false,
      escalationForced: true,
      identityViolation: false,
      crossVentureViolation: false,
      riskCategories: ['safety_wellbeing'],
      notes: ['crisis_support', 'no_model_call'],
    };
    const blocked = TestTurnResponse.parse({
      release: { id: ID, version: 2, status: 'draft' },
      status: 'blocked',
      response: null,
      evidence: [],
      validator,
      blocked: { reason: 'crisis_support', supportMessage: 'Call 988.' },
    });
    expect(blocked.blocked?.reason).toBe('crisis_support');
    expect(
      TestTurnResponse.safeParse({ ...blocked, release: { id: ID, version: 2, status: 'live' } }).success,
    ).toBe(false);
  });
});
