import { describe, expect, it } from 'vitest';

import { IDS, makeMemory } from '@/features/knowledge/testing';

import { memoryProvenance } from './provenance';

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

  it('says it came from a call when the server records the channel', () => {
    const call = memoryProvenance(
      makeMemory({
        origin: 'ai',
        sourceRefs: [
          { kind: 'session', id: IDS.session, label: 'call' },
          { kind: 'turn', id: IDS.turn },
        ],
      }),
    );
    expect(call.text).toMatch(/^Learned from the call on /);
    expect(call.sessionId).toBe(IDS.session);
    expect(
      memoryProvenance(
        makeMemory({ origin: 'ai', sourceRefs: [{ kind: 'turn', id: IDS.turn, label: 'Call' }] }),
      ).text,
    ).toMatch(/^Learned from a call on /);
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
