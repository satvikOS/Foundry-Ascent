/**
 * The startup knowledge base shipped with the code (the owner's canonical JSON, kept byte for byte as supplied)
 * and its retrieval evaluation questions.
 */
import rawEval from '../../knowledge/startup-knowledge-base/rag_eval_questions.json' with { type: 'json' };
import rawPack from '../../knowledge/startup-knowledge-base/startup_knowledge_base.json' with { type: 'json' };
import { type KnowledgePack, type PackEvalQuestion } from './types.js';
import { validateKnowledgePack } from './validate.js';

/** The canonical JSON as parsed, unvalidated (tests corrupt copies of it). */
export function rawKnowledgePack(): unknown {
  return structuredClone(rawPack);
}

/** The shipped pack, validated: throws listing every problem when it is invalid. */
export function loadKnowledgePack(raw: unknown = rawPack): KnowledgePack {
  const errors = validateKnowledgePack(raw);
  if (errors.length > 0) {
    throw new Error(`invalid startup knowledge base: ${errors.slice(0, 10).join('; ')}`);
  }
  return raw as KnowledgePack;
}

/** The pack's retrieval evaluation questions (Q05 is the abstention case: nothing answers it). */
export function knowledgePackEvalQuestions(): readonly PackEvalQuestion[] {
  const questions: readonly PackEvalQuestion[] = rawEval;
  return questions;
}
