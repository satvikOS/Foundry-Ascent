import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AdminPrincipalRow,
  ApprovePersonaReleaseResponse,
  CompleteDocumentResponse,
  CreateEscalationResponse,
  CreateMemoryResponse,
  CreatePersonaReleaseResponse,
  CreatePrincipalResponse,
  CreateProgramVentureResponse,
  CreateResourceResponse,
  CreateSessionResponse,
  CreateTurnRequest,
  DocumentView,
  EscalationActionResponse,
  EscalationQueueItem,
  EscalationView,
  HealthResponse,
  MemoryActionResponse,
  MemoryObjectView,
  PersonaReleaseView,
  PersonaView,
  ProgramVentureRow,
  ResourceView,
  ResumePersonaResponse,
  RevokeAccessCodeResponse,
  RouteEscalationResponse,
  SessionView,
  SubmitReviewResponse,
  SuspendPersonaResponse,
  UpdateResourceResponse,
  ERROR_STATUS,
  ErrorCode,
  Me,
  MemoryQuery,
  RequestedRole,
  ResourceFilter,
  SignInResponse,
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
      [RouteEscalationResponse, EscalationQueueItem],
    ];
    for (const [response, view] of pairs) expect(response).toBe(view);
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
