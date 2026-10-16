import { describe, expect, it } from 'vitest';

import { IDS, makeMemory } from '@/features/knowledge/testing';

import { learnedFromConversation, memoryProvenance } from './provenance';

const MAYA = { id: IDS.principal, displayName: 'Maya Okafor-Lindqvist', title: null, synthetic: true };
const ON = /on Oct 1, 2026$/;

describe('memoryProvenance', () => {
  it('says the vEIR learned it from the conversation, and links it when the source names one', () => {
    const fromConversation = memoryProvenance(
      makeMemory({ origin: 'ai', createdBy: MAYA, sourceRefs: [{ kind: 'session', id: IDS.session }] }),
    );
    expect(fromConversation.text).toMatch(/^Learned from the conversation on /);
    expect(fromConversation.text).toMatch(ON);
    expect(fromConversation.sessionId).toBe(IDS.session);

    const fromAnswer = memoryProvenance(
      makeMemory({ origin: 'ai', sourceRefs: [{ kind: 'turn', id: IDS.turn, label: 'AI proposal' }] }),
    );
    expect(fromAnswer.text).toMatch(/^Learned from a conversation on /);
    expect(fromAnswer.sessionId).toBeNull();
  });

  it('says it came from the call when its conversation had one (the conversation says so, not a label)', () => {
    // As memory kept automatically names its source: the conversation, with a label, and the turn.
    const learned = makeMemory({
      origin: 'ai',
      sourceRefs: [
        { kind: 'session', id: IDS.session, label: 'Learned from the conversation' },
        { kind: 'turn', id: IDS.turn },
      ],
    });
    const call = memoryProvenance(learned, new Set([IDS.session]));
    expect(call.text).toMatch(/^Learned from the call on /);
    expect(call.text).toMatch(ON);
    expect(call.sessionId).toBe(IDS.session);
    // A conversation without a call, or one not known yet, reads as the conversation.
    expect(memoryProvenance(learned, new Set([IDS.turn])).text).toMatch(/^Learned from the conversation on /);
    expect(memoryProvenance(learned).text).toMatch(/^Learned from the conversation on /);
    // A label alone never makes it a call.
    expect(
      memoryProvenance(
        makeMemory({ origin: 'ai', sourceRefs: [{ kind: 'session', id: IDS.session, label: 'call' }] }),
      ).text,
    ).toMatch(/^Learned from the conversation on /);
  });

  it('names the conversation only for what the vEIR learned', () => {
    expect(
      learnedFromConversation(
        makeMemory({ origin: 'ai', sourceRefs: [{ kind: 'session', id: IDS.session }] }),
      ),
    ).toBe(IDS.session);
    expect(
      learnedFromConversation(makeMemory({ origin: 'ai', sourceRefs: [{ kind: 'turn', id: IDS.turn }] })),
    ).toBeNull();
    expect(
      learnedFromConversation(
        makeMemory({ origin: 'founder', sourceRefs: [{ kind: 'session', id: IDS.session }] }),
      ),
    ).toBeNull();
  });

  it('never credits the vEIR’s memory to the founder whose conversation it came from', () => {
    expect(memoryProvenance(makeMemory({ origin: 'ai', createdBy: MAYA })).text).not.toContain('Maya');
  });

  it('names a person who added it, and imports', () => {
    expect(memoryProvenance(makeMemory({ origin: 'founder', createdBy: MAYA })).text).toMatch(
      /^Added by Maya Okafor-Lindqvist on /,
    );
    expect(memoryProvenance(makeMemory({ origin: 'import' })).text).toMatch(/^Imported on /);
  });
});
