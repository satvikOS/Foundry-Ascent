import {
  AssignPersonaRequest,
  ConsentListResponse,
  ConsentView,
  CreateConsentRequest,
  CreateDocumentRequest,
  CreateEirPersonaRequest,
  CreateEirProfileRequest,
  CreateLessonRequest,
  CreatePersonaKnowledgeRequest,
  CreatePersonaUploadResponse,
  DigitalTwinView,
  EirCandidateListResponse,
  EirProfileListResponse,
  EirProfileView,
  LessonAction,
  LessonListResponse,
  LessonView,
  MAX_DOCUMENT_BYTES,
  PersonaEmbodiment,
  PersonaKnowledgeListResponse,
  PersonaKnowledgeSourceView,
  PersonaView,
  ProgramVentureRow,
  RevokeConsentResponse,
  type TwinMediaKind,
  UpdateEirProfileRequest,
  UpdateEmbodimentRequest,
  UpdatePersonaKnowledgeRequest,
  UpdateTwinMediaRequest,
  WithdrawConsentScopeRequest,
  WithdrawConsentScopeResponse,
  type WithdrawableScope,
} from '@foundry/contracts';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';

import { encodeBody } from '../body';
import { api, createIdempotencyKey, path } from '../client';
import { ApiError } from '../errors';
import { queryKeys } from '../query-keys';
import { documentContentType, uploadToPresignedUrl, type UploadProgress } from './documents';

/*
 * vEIR knowledge pools as the EIR studio and program consoles manage them: the common pool (knowledge
 * library and lessons), consent and embodiment, EIR personas and venture assignments. Kept apart from
 * ./eir and ./program, whose query options route loaders import into the main bundle; these hooks load
 * with the studio pages that use them.
 */

function useInvalidatePersonas() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.personas.all() });
}

export type AssignPersonaInput = z.input<typeof AssignPersonaRequest>;

/**
 * POST /ventures/:id/assignment — the venture's vEIR and reviewing EIR (program lead) → 200
 * `ProgramVentureRow`. Open conversations with the previous vEIR end at their next message.
 */
export function useAssignPersona() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ventureId, input }: { ventureId: string; input: AssignPersonaInput }) =>
      api.post(
        path`/ventures/${ventureId}/assignment`,
        ProgramVentureRow,
        encodeBody(AssignPersonaRequest, input),
        {
          idempotencyKey: createIdempotencyKey(),
        },
      ),
    onSuccess: (_row, { ventureId }) => {
      void client.invalidateQueries({ queryKey: queryKeys.program.ventures() });
      void client.invalidateQueries({ queryKey: queryKeys.personas.all() });
      void client.invalidateQueries({ queryKey: queryKeys.venture.scope(ventureId) });
    },
  });
}

export type EirProfile = z.infer<typeof EirProfileListResponse>['items'][number];

/** GET /eir/profiles — the EIR registry (any EIR-studio role). */
export function useEirProfiles(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.eir.profiles(),
    queryFn: ({ signal }) => api.get('/eir/profiles', EirProfileListResponse, { signal }),
    staleTime: 5 * 60_000,
    enabled: options.enabled ?? true,
    select: (data) => data.items,
  });
}

/** GET /eir/candidates — people with the EIR role and no profile yet (program lead or platform admin). */
export function useEirCandidates(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.eir.candidates(),
    queryFn: ({ signal }) => api.get('/eir/candidates', EirCandidateListResponse, { signal }),
    enabled: options.enabled ?? true,
    select: (data) => data.items,
  });
}

function useInvalidateEirRegistry() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.eir.profiles() }),
      client.invalidateQueries({ queryKey: queryKeys.eir.candidates() }),
      // Personas show their EIR's name.
      client.invalidateQueries({ queryKey: queryKeys.personas.all() }),
    ]);
}

export type CreateEirProfileInput = z.input<typeof CreateEirProfileRequest>;

/** POST /eir/profiles → 201 the new EIR (program lead or platform admin). It records no consent. */
export function useCreateEirProfile() {
  const invalidate = useInvalidateEirRegistry();
  return useMutation({
    mutationFn: (input: CreateEirProfileInput) =>
      api.post('/eir/profiles', EirProfileView, encodeBody(CreateEirProfileRequest, input), {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: invalidate,
  });
}

export type UpdateEirProfileInput = z.input<typeof UpdateEirProfileRequest>;

/** PATCH /eir/profiles/:id — name, title, areas of expertise or bio. */
export function useUpdateEirProfile() {
  const invalidate = useInvalidateEirRegistry();
  return useMutation({
    mutationFn: ({ profileId, input }: { profileId: string; input: UpdateEirProfileInput }) =>
      api.patch(
        path`/eir/profiles/${profileId}`,
        EirProfileView,
        encodeBody(UpdateEirProfileRequest, input),
        {
          idempotencyKey: createIdempotencyKey(),
        },
      ),
    onSuccess: invalidate,
  });
}

type CreateEirPersonaInput = z.input<typeof CreateEirPersonaRequest>;

/** POST /personas → 201 a draft EIR persona with its draft release v1 (program lead). */
export function useCreateEirPersona() {
  const invalidate = useInvalidatePersonas();
  return useMutation({
    mutationFn: (input: CreateEirPersonaInput) =>
      api.post('/personas', PersonaView, encodeBody(CreateEirPersonaRequest, input), {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: invalidate,
  });
}

// Common pool: knowledge library --------------------------------------------------------------------

export type LibrarySource = PersonaKnowledgeSourceView;

/** GET /personas/:id/knowledge — polls every 3 s while an upload is being processed. */
export function usePersonaLibrary(personaId: string) {
  return useQuery({
    queryKey: queryKeys.personas.library(personaId),
    queryFn: ({ signal }) =>
      api.get(path`/personas/${personaId}/knowledge`, PersonaKnowledgeListResponse, { signal }),
    refetchInterval: (query) =>
      query.state.data?.items.some((source) => source.status === 'processing') ? 3000 : false,
    select: (data) => data.items,
  });
}

function useInvalidateLibrary(personaId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.personas.library(personaId) });
}

type CreateLibrarySourceInput = z.input<typeof CreatePersonaKnowledgeRequest>;

/** POST /personas/:id/knowledge → 201 an authored note, case, FAQ or transcript (chunked on save). */
export function useCreateLibrarySource(personaId: string) {
  const invalidate = useInvalidateLibrary(personaId);
  return useMutation({
    mutationFn: (input: CreateLibrarySourceInput) =>
      api.post(
        path`/personas/${personaId}/knowledge`,
        PersonaKnowledgeSourceView,
        encodeBody(CreatePersonaKnowledgeRequest, input),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: invalidate,
  });
}

type UpdateLibrarySourceInput = z.input<typeof UpdatePersonaKnowledgeRequest>;

/** PATCH /personas/:id/knowledge/:sourceId — the title, or the text of an authored source. */
export function useUpdateLibrarySource(personaId: string) {
  const invalidate = useInvalidateLibrary(personaId);
  return useMutation({
    mutationFn: ({ sourceId, input }: { sourceId: string; input: UpdateLibrarySourceInput }) =>
      api.patch(
        path`/personas/${personaId}/knowledge/${sourceId}`,
        PersonaKnowledgeSourceView,
        encodeBody(UpdatePersonaKnowledgeRequest, input),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: invalidate,
  });
}

/** DELETE /personas/:id/knowledge/:sourceId → 204; the source leaves retrieval at once. */
export function useRemoveLibrarySource(personaId: string) {
  const invalidate = useInvalidateLibrary(personaId);
  return useMutation({
    mutationFn: (sourceId: string) =>
      api.delete(path`/personas/${personaId}/knowledge/${sourceId}`, {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: invalidate,
  });
}

/** POST /personas/:id/knowledge/:sourceId/complete — starts (or retries) processing an upload. */
export function useRetryLibraryUpload(personaId: string) {
  const invalidate = useInvalidateLibrary(personaId);
  return useMutation({
    mutationFn: (sourceId: string) =>
      api.post(
        path`/personas/${personaId}/knowledge/${sourceId}/complete`,
        PersonaKnowledgeSourceView,
        undefined,
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: invalidate,
  });
}

interface UploadLibraryDocumentVariables {
  file: File;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/**
 * Upload a document to the library: request a presigned PUT (the daily upload quota applies), upload, then
 * mark it complete, which queues ingestion. The library list polls until processing settles.
 */
export function useUploadLibraryDocument(personaId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, onProgress, signal }: UploadLibraryDocumentVariables) => {
      const contentType = documentContentType(file);
      if (!contentType) {
        throw new ApiError({ status: 415, code: 'unsupported_media_type', title: 'Unsupported file type' });
      }
      if (file.size > MAX_DOCUMENT_BYTES) {
        throw new ApiError({ status: 413, code: 'upload_too_large', title: 'File too large' });
      }
      const ticket = await api.post(
        path`/personas/${personaId}/knowledge/uploads`,
        CreatePersonaUploadResponse,
        encodeBody(CreateDocumentRequest, { filename: file.name, contentType, sizeBytes: file.size }),
        { idempotencyKey: createIdempotencyKey(), signal },
      );
      await uploadToPresignedUrl(ticket.upload, file, { onProgress, signal });
      return api.post(
        path`/personas/${personaId}/knowledge/${ticket.source.id}/complete`,
        PersonaKnowledgeSourceView,
        undefined,
        { idempotencyKey: createIdempotencyKey(), signal },
      );
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.personas.library(personaId) }),
  });
}

// Common pool: lessons ------------------------------------------------------------------------------

/** GET /personas/:id/lessons — drafts are visible to the persona's curators only. */
const personaLessonsQueryOptions = (personaId: string) =>
  queryOptions({
    queryKey: queryKeys.personas.lessons(personaId),
    queryFn: ({ signal }) => api.get(path`/personas/${personaId}/lessons`, LessonListResponse, { signal }),
  });

export function usePersonaLessons(personaId: string) {
  return useQuery({ ...personaLessonsQueryOptions(personaId), select: (data) => data.items });
}

export type CreateLessonInput = z.input<typeof CreateLessonRequest>;

/** POST /personas/:id/lessons → 201 a draft lesson. */
export function useCreateLesson(personaId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLessonInput) =>
      api.post(path`/personas/${personaId}/lessons`, LessonView, encodeBody(CreateLessonRequest, input), {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.personas.lessons(personaId) }),
        client.invalidateQueries({ queryKey: queryKeys.personas.lessonsToReview() }),
      ]),
  });
}

export type LessonActionInput = z.input<typeof LessonAction>;

/** POST /lessons/:id/actions — edit, publish or withdraw. */
export function useLessonAction(personaId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ lessonId, action }: { lessonId: string; action: LessonActionInput }) =>
      api.post(path`/lessons/${lessonId}/actions`, LessonView, encodeBody(LessonAction, action), {
        idempotencyKey: createIdempotencyKey(),
      }),
    // The persona's list and the review queue (and the sidebar's count) both change.
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.personas.lessons(personaId) }),
        client.invalidateQueries({ queryKey: queryKeys.personas.lessonsToReview() }),
      ]),
  });
}

// Consent and embodiment ----------------------------------------------------------------------------

/** GET /personas/:id/consents — program leads and the persona's EIR (`enabled: false` for anyone else). */
export function usePersonaConsents(personaId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.personas.consents(personaId),
    queryFn: ({ signal }) => api.get(path`/personas/${personaId}/consents`, ConsentListResponse, { signal }),
    enabled: options.enabled ?? true,
    select: (data) => data.items,
  });
}

function useInvalidateConsent(personaId: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.personas.all() }),
      client.invalidateQueries({ queryKey: queryKeys.personas.embodiment(personaId) }),
      // Ventures show their vEIR's status; a revocation suspends it.
      client.invalidateQueries({ queryKey: queryKeys.venture.all() }),
    ]);
}

export type RecordConsentInput = z.input<typeof CreateConsentRequest>;

/** POST /personas/:id/consents → 201; the persona relies on it from now on. It must cover doctrine. */
export function useRecordConsent(personaId: string) {
  const invalidate = useInvalidateConsent(personaId);
  return useMutation({
    mutationFn: (input: RecordConsentInput) =>
      api.post(path`/personas/${personaId}/consents`, ConsentView, encodeBody(CreateConsentRequest, input), {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: invalidate,
  });
}

/** POST /consents/:id/revoke — every active persona relying on it is suspended. */
export function useRevokeConsent(personaId: string) {
  const invalidate = useInvalidateConsent(personaId);
  return useMutation({
    mutationFn: (consentId: string) =>
      api.post(path`/consents/${consentId}/revoke`, RevokeConsentResponse, undefined, {
        idempotencyKey: createIdempotencyKey(),
      }),
    onSuccess: invalidate,
  });
}

/** GET /personas/:id/embodiment — the call provider, the voice and what the consent covers. */
export function usePersonaEmbodiment(personaId: string) {
  return useQuery({
    queryKey: queryKeys.personas.embodiment(personaId),
    queryFn: ({ signal }) => api.get(path`/personas/${personaId}/embodiment`, PersonaEmbodiment, { signal }),
  });
}

type UpdateEmbodimentInput = z.input<typeof UpdateEmbodimentRequest>;

/** PATCH /personas/:id/embodiment — a voice needs a consent covering voice. */
export function useUpdateEmbodiment(personaId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateEmbodimentInput) =>
      api.patch(
        path`/personas/${personaId}/embodiment`,
        PersonaEmbodiment,
        encodeBody(UpdateEmbodimentRequest, input),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: (embodiment) => {
      client.setQueryData(queryKeys.personas.embodiment(personaId), embodiment);
    },
  });
}

// Digital twin ---------------------------------------------------------------------------------------

/** GET /personas/:id/twin — the persona's face and cloned voice and the scopes that cover them (curators). */
export function useDigitalTwin(personaId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.personas.twin(personaId),
    queryFn: ({ signal }) => api.get(path`/personas/${personaId}/twin`, DigitalTwinView, { signal }),
    enabled: options.enabled ?? true,
  });
}

export type UpdateTwinMediaInput = z.input<typeof UpdateTwinMediaRequest>;

/** PATCH /personas/:id/twin/:kind — records the vendor id of the face or voice; `ready` needs its scope. */
export function useUpdateTwinMedia(personaId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, ...input }: UpdateTwinMediaInput & { kind: TwinMediaKind }) =>
      api.patch(
        path`/personas/${personaId}/twin/${kind}`,
        DigitalTwinView,
        encodeBody(UpdateTwinMediaRequest, input),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: (twin) => {
      client.setQueryData(queryKeys.personas.twin(personaId), twin);
    },
  });
}

/** POST /consents/:id/withdraw-scope — the consent continues without that scope; nobody is suspended. */
export function useWithdrawScope(personaId: string) {
  const invalidate = useInvalidateConsent(personaId);
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ consentId, assetType }: { consentId: string; assetType: WithdrawableScope }) =>
      api.post(
        path`/consents/${consentId}/withdraw-scope`,
        WithdrawConsentScopeResponse,
        encodeBody(WithdrawConsentScopeRequest, { assetType }),
        { idempotencyKey: createIdempotencyKey() },
      ),
    onSuccess: () =>
      Promise.all([
        invalidate(),
        client.invalidateQueries({ queryKey: queryKeys.personas.consents(personaId) }),
        client.invalidateQueries({ queryKey: queryKeys.personas.twin(personaId) }),
      ]),
  });
}
