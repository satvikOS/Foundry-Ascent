/**
 * The startup knowledge base (schema 3.0.0): the canonical JSON the owner supplied
 * (`packages/db/knowledge/startup-knowledge-base/startup_knowledge_base.json`). Field names and meanings are the
 * pack's own (its README): historical case facts (`context`, `problem`, `actual_actions`, `reported_outcome`,
 * `outcome_limitations`) are separate from editorial guidance (`analysis`, `possible_solutions`,
 * `proposed_experiment`, `primary_metric`, `decision_rule`), and case references (`case_source_ids`, B-series)
 * are separate from method references (`method_source_ids`, A-series).
 */

export interface PackMetadata {
  readonly title: string;
  readonly schema_version: string;
  readonly created_date: string;
  readonly reviewed_date?: string;
  readonly language: string;
  readonly framework_count: number;
  readonly scenario_count: number;
  readonly source_count: number;
  readonly lifecycle_stage_count: number;
  readonly rag_document_count: number;
  readonly scope: string;
  readonly methodology: string;
  readonly threshold_policy: string;
  readonly source_policy: string;
  /** Stage id → description (editorial). */
  readonly stages: Readonly<Record<string, string>>;
}

export interface PackFramework {
  readonly framework_id: string;
  readonly name: string;
  readonly category: string;
  readonly stages: readonly string[];
  readonly description: string;
  readonly when_to_use: string;
  readonly how_to_use: readonly string[];
  readonly expected_output: string;
  readonly limitations: string;
  readonly source_ids: readonly string[];
  readonly evidence_note: string;
}

export interface PackScenario {
  readonly scenario_id: string;
  readonly title: string;
  readonly company: string;
  readonly industry: string;
  readonly stage: string;
  readonly category: string;
  readonly scenario_type: string;
  readonly case_period: string;
  /** The source date (day or year precision), not the date of every event. */
  readonly evidence_as_of: string;
  readonly context: string;
  readonly problem: string;
  readonly actual_actions: readonly string[];
  readonly reported_outcome: string;
  /** What the cited account does not establish. */
  readonly outcome_limitations: string;
  readonly analysis: string;
  readonly possible_solutions: readonly string[];
  readonly proposed_experiment: string;
  readonly primary_metric: string;
  readonly decision_rule: string;
  readonly risks_and_constraints: string;
  readonly framework_ids: readonly string[];
  readonly case_source_ids: readonly string[];
  readonly method_source_ids: readonly string[];
  readonly source_ids: readonly string[];
  readonly evidence_locator: string;
  readonly source_scope: string;
  readonly evidence_date_precision: string;
}

export interface PackLink {
  readonly scenario_id: string;
  readonly framework_id: string;
  readonly application: string;
}

export interface PackSource {
  readonly source_id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly accessed_date: string;
  readonly source_type: string;
  readonly supports: string;
  readonly authors: string;
  readonly publication_year: string;
  readonly publication: string;
  readonly peer_review_status: string;
  readonly eligibility_note: string;
}

export interface PackAudit {
  readonly source_id: string;
  readonly checked_date: string;
  readonly access_status: string;
  readonly claim_status: string;
  readonly locator: string;
  readonly finding: string;
  readonly limitation: string;
  readonly url: string;
}

export interface PackStage {
  readonly stage_id: string;
  readonly name: string;
  readonly objective: string;
  readonly common_challenges: readonly string[];
  readonly mentorship_needed: readonly string[];
  readonly expected_outputs: string;
  readonly progression_evidence: string;
  readonly framework_ids: readonly string[];
  readonly source_ids: readonly string[];
  readonly evidence_note: string;
}

export interface PackRagDocument {
  readonly doc_id: string;
  readonly title: string;
  readonly category: string;
  readonly stages: readonly string[];
  readonly framework_ids: readonly string[];
  readonly source_ids: readonly string[];
  readonly evidence_type: string;
  readonly language: string;
  readonly version: string;
  readonly updated_date: string;
  readonly access_scope: string;
  readonly path: string;
}

export interface PackRagChunk extends PackRagDocument {
  readonly chunk_id: string;
  readonly section: string;
  readonly text: string;
  readonly content_sha256: string;
  readonly chunking_method: string;
  readonly size_unit: string;
  readonly size: number;
}

export interface KnowledgePack {
  readonly metadata: PackMetadata;
  readonly frameworks: readonly PackFramework[];
  readonly scenarios: readonly PackScenario[];
  readonly scenario_framework_links: readonly PackLink[];
  readonly sources: readonly PackSource[];
  readonly source_audit: readonly PackAudit[];
  readonly lifecycle_stages: readonly PackStage[];
  readonly rag_documents: readonly PackRagDocument[];
  readonly rag_chunks: readonly PackRagChunk[];
}

export interface PackEvalQuestion {
  readonly question_id: string;
  readonly question: string;
  /** Empty: nothing in the pack answers it (the abstention case). */
  readonly expected_doc_ids: readonly string[];
  readonly expected_behavior: string;
}
