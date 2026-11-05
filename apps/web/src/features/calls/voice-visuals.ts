/**
 * The voice visuals as standalone pieces, for any surface that shows a call without being one (the landing page's
 * device ad): the sphere and the conversation timeline, driven by recorded envelopes of real measured audio.
 *
 *   const levels = recordedLevels({ veir: { samples: VEIR_ENVELOPE, startedAt: performance.now() } });
 *   <VoiceSphere state="speaking" levels={levels} size="9rem" />
 *
 *   const timeline = new TimelineRecorder();
 *   timeline.step({ veir: VEIR_ENVELOPE[i] ?? null, student: null }); // once per 100 ms of the sequence
 *   <ConversationTimeline source={timeline} names={{ veir: 'Corin · vEIR', student: 'You' }} />
 */
export { ConversationTimeline, turnLabel } from './timeline/ConversationTimeline';
export {
  pastTimeline,
  TimelineRecorder,
  type Speaker,
  type TimelineSource,
  type TimelineTurn,
} from './timeline/timeline-model';
export {
  envelopeLevel,
  recordedLevels,
  VoiceSphere,
  type RecordedEnvelope,
  type SphereState,
  type VoiceSphereProps,
} from './voice-sphere';
