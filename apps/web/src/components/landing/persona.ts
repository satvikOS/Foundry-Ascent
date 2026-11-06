/**
 * The mentor the landing page introduces, by the name students know him by. The page names him in its copy and
 * its device ad plays a session with him (device-ad/session.json); landing.test keeps the two the same. Nothing
 * here says he is a person: the disclosure under the hero says what he is and how he is made.
 */
export const PERSONA = 'Thomas';

/** The disclosure line's always-visible part: short enough to stay whole on a phone. */
export const LANDING_DISCLOSURE_SUMMARY = `${PERSONA} is an AI mentor, not a person.`;

/**
 * The disclosure in full ("More", and always for screen readers), as his release says it (ADR-0021): his coaching
 * approach is the program's, written and approved before release; no person writes or approves each reply, and no
 * entrepreneur-in-residence is said to have written or reviewed it.
 */
export const LANDING_DISCLOSURE =
  `${PERSONA} is an AI mentor, not a person. His coaching approach was written and approved by the program; no ` +
  'person writes or approves his individual replies. A person from the program is there when you need one.';
