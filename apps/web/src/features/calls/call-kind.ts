import type { CallConfigResponse } from '@foundry/contracts';

/**
 * The two kinds of call (owner, 2026-11-05): a VOICE call is the sphere and the timeline, no face; a VIDEO call
 * shows the vEIR's live avatar face, when this person is offered one. The kind is the URL's `?call=voice|video`
 * before a call starts, then the call's own (it can switch while live where the vendor allows).
 */
export type CallKind = 'voice' | 'video';

export const CALL_KIND_LABEL: Record<CallKind, string> = { voice: 'Voice call', video: 'Video call' };

/**
 * The kind a `?call=` value asks for: `video`, or `voice` (also the older `?call=1` links, and `true`). Anything
 * else is no call at all.
 */
export function callKindFrom(value: unknown): CallKind | undefined {
  if (value === 'video') return 'video';
  if (value === 'voice' || value === 1 || value === '1' || value === true) return 'voice';
  return undefined;
}

/** What `validateSearch` keeps of `?call=` on New chat and a conversation. */
export function callSearch(search: Record<string, unknown>): CallKind | undefined {
  return callKindFrom(search.call);
}

export type VideoAvailability =
  { readonly available: true } | { readonly available: false; readonly reason: string };

/** Said wherever Video is shown but cannot start (the button's tooltip, the menu row's second line). */
export const VIDEO_UNAVAILABLE = 'Video isn’t available for you yet. Voice works.';

/**
 * Whether this person may make a video call now: the call settings name a face for them (the server decides who
 * is offered one: faces on, the audience, the likeness consent and the video minutes left). Unknown (null) until
 * the call settings load.
 */
export function videoAvailability(
  config: Pick<CallConfigResponse, 'provider'> | undefined,
): VideoAvailability | null {
  if (config === undefined) return null;
  return config.provider === 'builtin'
    ? { available: false, reason: VIDEO_UNAVAILABLE }
    : { available: true };
}
