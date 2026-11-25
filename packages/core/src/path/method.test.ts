/**
 * The method lint (packages/ai validators/method.ts) over the method itself: what the plays and the shared knowledge say
 * must pass it, sentence by sentence, as a model gives it in a reply. Nothing that teaches the method may be taken for what
 * contradicts it.
 */
import { readFileSync } from 'node:fs';

import { methodText } from '@foundry/ai';
import { describe, expect, it } from 'vitest';

import { PLAYBOOK } from './playbook/index.js';

const taken = (text: string): string[] => {
  const read = methodText(text);
  // A blank of a template is the founder's to fill in: only words are the lint's.
  return read.findings.filter((f) => f !== 'empty_bracket').map((f) => `${f}: ${text}`);
};

describe('the method passes the method lint', () => {
  it('every answer, reason, part, done-when and referral of the playbook', () => {
    const texts = PLAYBOOK.plays.flatMap((p) => [
      p.answer,
      p.why,
      p.doneWhen,
      ...p.steps.flatMap((s) => [s.do, s.how]),
      ...(p.referral === null ? [] : [p.referral.who, p.referral.bring]),
    ]);
    expect(texts.length).toBeGreaterThan(900);
    expect(texts.flatMap(taken)).toEqual([]);
  });

  it('the traps, as a reply warns of them', () => {
    expect(PLAYBOOK.plays.flatMap((p) => p.traps).flatMap(taken)).toEqual([]);
  });

  it('the shared knowledge base', () => {
    const file = new URL(
      '../../../db/knowledge/startup-knowledge-base/startup_knowledge_base.json',
      import.meta.url,
    );
    const texts: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        if (value.length > 60) texts.push(value);
      } else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
    };
    walk(JSON.parse(readFileSync(file, 'utf8')));
    expect(texts.length).toBeGreaterThan(200);
    expect(texts.flatMap(taken)).toEqual([]);
  });
});
