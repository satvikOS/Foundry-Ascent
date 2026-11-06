import { describe, expect, it } from 'vitest';

import { EXCERPT_CHARS } from '../repositories/common.js';
import { validationReport } from '../scripts/knowledge-pack.js';
import { knowledgePackEvalQuestions, loadKnowledgePack, rawKnowledgePack } from './pack.js';
import { PACK_URI_PREFIX, packItems, ragTemplate } from './render.js';
import { type KnowledgePack } from './types.js';
import { CORRUPTION_CASES, codePoints, sha256Hex, validateKnowledgePack } from './validate.js';

const pack = loadKnowledgePack();
const items = packItems(pack);

describe('startup knowledge base: validation (validate_kb.py semantics)', () => {
  it('the shipped canonical JSON is valid, with the counts its metadata states', () => {
    expect(validateKnowledgePack(rawKnowledgePack())).toEqual([]);
    expect(pack.metadata.schema_version).toBe('3.0.0');
    expect([
      pack.frameworks.length,
      pack.scenarios.length,
      pack.sources.length,
      pack.lifecycle_stages.length,
      pack.rag_documents.length,
    ]).toEqual([9, 25, 39, 6, 5]);
  });

  it.each(CORRUPTION_CASES.map((c) => [c.name, c] as const))('rejects a pack with: %s', (_name, c) => {
    const trial = rawKnowledgePack() as Record<string, never>;
    c.mutate(trial);
    expect(validateKnowledgePack(trial).length).toBeGreaterThan(0);
    expect(() => loadKnowledgePack(trial)).toThrow(/invalid startup knowledge base/);
  });

  it('runs all seventeen of the Python self-test corruptions', () => {
    expect(CORRUPTION_CASES).toHaveLength(17);
  });

  it('the validate command passes and reports every item and the RAG documents they reproduce', () => {
    const report = validationReport();
    expect(report).toMatchObject({ status: 'PASS', errors: [], selfTestsMissed: [], passages: 99 });
    expect(report.selfTestsPassed).toHaveLength(17);
    expect(report.items).toEqual({ framework: 9, case: 25, stage: 6 });
    expect(Object.keys(report.ragDocuments).sort()).toEqual([
      'DOC_F01',
      'DOC_F04',
      'DOC_F07',
      'DOC_GROWTH',
      'DOC_SC01',
    ]);
  });

  it('counts sizes in code points, as Python does', () => {
    expect(codePoints('Academic–Practitioner')).toBe(21);
    for (const c of pack.rag_chunks) expect(c.size).toBe(codePoints(c.text));
  });
});

describe('startup knowledge base: items', () => {
  it('makes one item per framework, documented case and lifecycle stage, with stable unique keys and uris', () => {
    expect(items.map((i) => i.kind).filter((k) => k === 'framework')).toHaveLength(9);
    expect(items.map((i) => i.kind).filter((k) => k === 'case')).toHaveLength(25);
    expect(items.map((i) => i.kind).filter((k) => k === 'stage')).toHaveLength(6);
    expect(new Set(items.map((i) => i.uri)).size).toBe(items.length);
    for (const item of items) {
      expect(item.uri).toBe(`${PACK_URI_PREFIX}${item.key}`);
      // The app splits a passage title "<source> — <heading>" at the first dash pair.
      expect(item.title).not.toContain(' — ');
      expect(item.checksum).toMatch(/^skb@3\.0\.0:sha256:[0-9a-f]{64}$/);
    }
    expect(packItems(pack)).toEqual(items);
  });

  it('reproduces each of the five RAG documents byte for byte from exactly one item (hash checked)', () => {
    const reproduced = items.filter((i) => i.ragDocId !== null);
    expect(reproduced.map((i) => [i.ragDocId, i.key]).sort()).toEqual([
      ['DOC_F01', 'framework/F01'],
      ['DOC_F04', 'framework/F04'],
      ['DOC_F07', 'framework/F07'],
      ['DOC_GROWTH', 'stage/growth'],
      ['DOC_SC01', 'case/SC01'],
    ]);
    for (const chunk of pack.rag_chunks) {
      const item = reproduced.find((i) => i.ragDocId === chunk.doc_id);
      const [kind, id] = (item?.key ?? '').split('/') as ['framework' | 'case' | 'stage', string];
      expect(sha256Hex(ragTemplate(pack, kind, id))).toBe(chunk.content_sha256);
    }
  });

  it('refuses a pack whose RAG document no item reproduces', () => {
    const drifted = structuredClone(pack) as { -readonly [K in keyof KnowledgePack]: KnowledgePack[K] };
    drifted.frameworks = drifted.frameworks.map((f) =>
      f.framework_id === 'F01' ? { ...f, description: `${f.description} Changed.` } : f,
    );
    expect(() => packItems(drifted)).toThrow(/DOC_F01 is not reproduced/);
  });

  it('keeps a case’s documented account apart from its editorial guidance, with its date and limits', () => {
    for (const s of pack.scenarios) {
      const item = items.find((i) => i.key === `case/${s.scenario_id}`);
      if (!item) throw new Error(s.scenario_id);
      const [documented, editorial, options] = item.passages;
      expect(documented?.epistemic).toBe('documented_account');
      expect(documented?.heading).toContain(`evidence as of ${s.evidence_as_of}`);
      expect(documented?.content).toContain(s.reported_outcome);
      expect(documented?.content).toContain(`Evidence limits: ${s.outcome_limitations}`);
      // What the account does not establish reaches the coach: it is within the excerpt retrieval returns.
      expect(documented?.content.slice(0, EXCERPT_CHARS - 1)).toContain(s.outcome_limitations);
      // Editorial text never sits in the documented account, and the reverse.
      expect(documented?.content).not.toContain(s.proposed_experiment);
      expect(documented?.content).not.toContain(s.analysis);
      expect(editorial?.heading).toBe('Editorial guidance, not company actions');
      expect(editorial?.epistemic).toBe('editorial_guidance');
      expect(editorial?.content).toContain(s.proposed_experiment);
      expect(editorial?.content).not.toContain(s.reported_outcome);
      expect(options?.heading).toMatch(/\(editorial\)$/);
      for (const solution of s.possible_solutions)
        expect(options?.content).toContain(solution.replace(/\.$/, ''));
      // Case references support the documented account; method references the editorial guidance.
      for (const id of s.case_source_ids) expect(documented?.content).toContain(`[${id}: `);
      for (const id of s.method_source_ids) {
        expect(documented?.content).not.toContain(`[${id}: `);
        expect(editorial?.content).toContain(`[${id}: `);
      }
      expect(item.freshnessAt).toBe('2026-11-02');
    }
  });

  it('names the real source in every passage heading and lists title, publisher and URL under References', () => {
    const sources = new Map(pack.sources.map((s) => [s.source_id, s]));
    for (const item of items) {
      const refs = item.body.slice(item.body.indexOf('## References'));
      expect(refs.startsWith('## References')).toBe(true);
      for (const id of item.sourceIds) {
        const s = sources.get(id);
        if (!s) throw new Error(id);
        expect(refs).toContain(`- ${id}: [${s.title}](${s.url}).`);
        expect(refs).toContain(s.publisher);
      }
      // Every passage is text of the body (the viewer marks the cited passage in it).
      for (const passage of item.passages) expect(item.body).toContain(passage.content);
    }
    const nona = items.find((i) => i.key === 'case/SC01');
    expect(nona?.passages[0]?.heading).toBe('Documented account · MIT / J-WAFS, evidence as of 2024-10-02');
    const lean = items.find((i) => i.key === 'framework/F01');
    expect(lean?.passages[0]?.heading).toBe(
      'Framework summary · sources: Entrepreneurship Theory and Practice',
    );
  });

  it('writes one full stop where the pack’s builder doubled it', () => {
    for (const item of items) expect(item.body).not.toMatch(/(?<!\.)\.\.(\s|$)/);
    expect(ragTemplate(pack, 'case', 'SC01')).toContain('programs..');
  });

  it('labels lifecycle stages and framework applications as editorial', () => {
    for (const item of items.filter((i) => i.kind === 'stage')) {
      expect(item.passages).toHaveLength(1);
      expect(item.passages[0]?.epistemic).toBe('editorial_guidance');
      expect(item.passages[0]?.content).toContain('not a prescribed universal sequence');
    }
  });

  it('ships the evaluation questions, the last one the abstention case', () => {
    const questions = knowledgePackEvalQuestions();
    expect(questions.map((q) => q.question_id)).toEqual(['Q01', 'Q02', 'Q03', 'Q04', 'Q05']);
    expect(questions.at(-1)?.expected_doc_ids).toEqual([]);
  });
});
