/**
 * The mentor the landing page introduces, by the name students know him by. The page names him in its copy and
 * its device ad plays a session with him (device-ad/session.json); landing.test keeps the two the same. Nothing
 * here says he is a person: the disclosure under the hero says what he is and how he is made.
 */
export const PERSONA = 'Thomas';

/** The disclosure line's always-visible part: short enough to stay whole on a phone. */
export const LANDING_DISCLOSURE_SUMMARY = `${PERSONA} is an AI mentor, not a person.`;

/**
 * The disclosure in full ("More", and always for screen readers). The EIR consents, approves the doctrine and
 * style he is built from and reviews each release; it does not claim a person approved each answer.
 */
export const LANDING_DISCLOSURE =
  `${PERSONA} is an AI mentor, not a person. He is built with an Ain Foundry entrepreneur-in-residence’s ` +
  'consent from their approved doctrine and coaching style, and released after their review. A person from the ' +
  'program is there when you need one.';
