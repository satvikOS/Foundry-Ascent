import type { Playbook } from '../types.js';
import { CRITERIA } from './criteria.js';
import { INTENTS } from './intents.js';
import { BUSINESS_MODEL_PLAYS } from './plays/business-model.js';
import { COMMERCIALIZATION_PLAYS } from './plays/commercialization.js';
import { DISCOVERY_PLAYS } from './plays/discovery.js';
import { GROWTH_PLAYS } from './plays/growth.js';
import { IDEA_PLAYS } from './plays/idea.js';
import { TRANSITION_PLAYS } from './plays/transition.js';
import { VALIDATION_PLAYS } from './plays/validation.js';
import { SOURCES } from './sources.js';
import { STAGES } from './stages.js';

/** Changes with any change of a play, a criterion or an intent: kept with each venture's path. */
export const PLAYBOOK_VERSION = '2026-11-25.1';

/** What a student founder hears: data only, the same for every founder; docs/architecture/playbook.md. */
export const PLAYBOOK: Playbook = {
  version: PLAYBOOK_VERSION,
  stages: STAGES,
  criteria: CRITERIA,
  plays: [
    ...IDEA_PLAYS,
    ...DISCOVERY_PLAYS,
    ...VALIDATION_PLAYS,
    ...BUSINESS_MODEL_PLAYS,
    ...COMMERCIALIZATION_PLAYS,
    ...GROWTH_PLAYS,
    ...TRANSITION_PLAYS,
  ],
  intents: INTENTS,
  sources: SOURCES,
};
