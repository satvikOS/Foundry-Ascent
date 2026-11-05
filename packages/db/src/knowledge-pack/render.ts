/**
 * The startup knowledge base as library items: one knowledge source per framework, documented case and
 * lifecycle stage, each with its text (Markdown, read in the document viewer) and the passages retrieval
 * searches and the coach cites.
 *
 * The text follows the pack's own RAG document templates (`build_deliverables.py`): the pack's five RAG
 * documents are exactly the rendering of five of these items, which {@link ragTemplate} reproduces byte for
 * byte (their SHA-256 is checked), so the pack's RAG sample is ingested as part of the whole collection rather
 * than as near-duplicate copies. Every item keeps the pack's epistemic labels:
 *
 * - a case's documented account (what the cited report says, bounded by its date, with what it does NOT
 *   establish) is one passage, and its editorial guidance (analysis, proposed experiment, metric, decision rule,
 *   options, framework mapping) is in separate passages headed as editorial, never as company actions;
 * - frameworks are method summaries with editorial application guidance; lifecycle stages are editorial
 *   recommendations, not a prescribed sequence.
 *
 * Provenance travels with the text: a passage's heading names the publisher of its references (and, for a
 * documented account, the date the evidence is as of), so the evidence title the coach and the founder see
 * carries title + publisher; the item's References section lists every source with title, authors,
 * publisher, year, URL, review date and the audit's stated limitation.
 */
import { sha256Hex } from './validate.js';
import {
  type KnowledgePack,
  type PackFramework,
  type PackScenario,
  type PackSource,
  type PackStage,
} from './types.js';

/** URI prefix of every item of this collection (its stable identity in `knowledge_sources.uri`). */
export const PACK_URI_PREFIX = 'urn:foundry:startup-knowledge-base:';

/** How a case's documented account passage is headed (retrieval prefers it to the case's editorial passages). */
export const DOCUMENTED_ACCOUNT_HEADING = 'Documented account';

export type PackItemKind = 'framework' | 'case' | 'stage';

export interface PackPassage {
  readonly heading: string;
  readonly content: string;
  /** What the passage is, for the coach and tests: a dated historical account, or guidance. */
  readonly epistemic: 'method_summary' | 'documented_account' | 'editorial_guidance';
}

export interface PackItem {
  /** `framework/F01`, `case/SC01`, `stage/growth`. */
  readonly key: string;
  readonly kind: PackItemKind;
  /** `knowledge_sources.uri`: {@link PACK_URI_PREFIX} + key. */
  readonly uri: string;
  readonly title: string;
  /** Markdown shown in the document viewer. */
  readonly body: string;
  readonly passages: readonly PackPassage[];
  /**
   * When the item was last checked against its references (the pack's source audit). A case's own evidence date is
   * in its documented account's heading ("evidence as of 2013-05-08"): the account is historical, not current.
   */
  readonly freshnessAt: string;
  /** Every reference the item cites, in the item's order (case references first for a case). */
  readonly sourceIds: readonly string[];
  /** The pack RAG document this item reproduces, if any. */
  readonly ragDocId: string | null;
  /** `skb@<schema>:sha256:<hex>` of title, body and passages: a changed checksum re-ingests the item. */
  readonly checksum: string;
}

interface Lookup {
  readonly sources: ReadonlyMap<string, PackSource>;
  readonly audit: ReadonlyMap<string, KnowledgePack['source_audit'][number]>;
  readonly frameworks: ReadonlyMap<string, PackFramework>;
}

function lookup(pack: KnowledgePack): Lookup {
  return {
    sources: new Map(pack.sources.map((s) => [s.source_id, s])),
    audit: new Map(pack.source_audit.map((a) => [a.source_id, a])),
    frameworks: new Map(pack.frameworks.map((f) => [f.framework_id, f])),
  };
}

function source(l: Lookup, id: string): PackSource {
  const s = l.sources.get(id);
  if (s === undefined) throw new Error(`knowledge pack: unknown source ${id}`);
  return s;
}

/** `[A01: Title](url); …`, exactly as the pack's builder writes references. */
function refs(l: Lookup, ids: readonly string[]): string {
  return ids.map((id) => `[${id}: ${source(l, id).title}](${source(l, id).url})`).join('; ');
}

/** The publishers of `ids` for a heading: the first two, then "and N more". */
function publishers(l: Lookup, ids: readonly string[]): string {
  const names = [...new Set(ids.map((id) => source(l, id).publisher))];
  const shown = names.slice(0, 2).join('; ');
  return names.length > 2 ? `${shown} and ${String(names.length - 2)} more` : shown;
}

/** A title never contains " — ": the app splits a passage's title "<source> — <heading>" there. */
function safeTitle(title: string): string {
  return title.replaceAll(' — ', ' – ');
}

/** A sentence ends with one full stop: the builder appends "." to lists whose last item already has one. */
function tidy(text: string): string {
  return text.replace(/(?<!\.)\.\.(?=\s|$)/g, '.');
}

/**
 * The pack's RAG document text for an item, exactly as `build_deliverables.py` writes it (including its doubled
 * full stops). The five RAG documents of the pack are this text for five items.
 */
export function ragTemplate(pack: KnowledgePack, kind: PackItemKind, id: string): string {
  const l = lookup(pack);
  if (kind === 'framework') {
    const f = l.frameworks.get(id);
    if (!f) throw new Error(`knowledge pack: unknown framework ${id}`);
    return (
      `# ${f.name}\n\nEvidence type: framework summary with editorial application guidance.\n\n${f.description}\n\n` +
      `When: ${f.when_to_use}\n\nSteps: ${f.how_to_use.join('; ')}.\n\nLimitations: ${f.limitations}\n\n` +
      `Sources: ${refs(l, f.source_ids)}`
    );
  }
  if (kind === 'case') {
    const s = pack.scenarios.find((x) => x.scenario_id === id);
    if (!s) throw new Error(`knowledge pack: unknown case ${id}`);
    return (
      `# ${s.title}\n\nEvidence type: documented real case with separately labeled editorial analysis. ` +
      `Evidence as of ${s.evidence_as_of}; later results are not asserted.\n\n## Documented account\n\n` +
      `${s.context} ${s.problem}\n\nActual actions: ${s.actual_actions.join('; ')}.\n\n` +
      `Reported outcome: ${s.reported_outcome}\n\nEvidence limits: ${s.outcome_limitations}\n\n` +
      `Case sources: ${refs(l, s.case_source_ids)}\n\nSource location: ${s.evidence_locator}\n\n` +
      `## Editorial guidance, not company actions\n\n${s.analysis}\n\n` +
      `Proposed experiment: ${s.proposed_experiment}\n\nSuggested metric: ${s.primary_metric}\n\n` +
      `Suggested decision rule: ${s.decision_rule}\n\n` +
      `Framework mapping is editorial; no claim that the company used each named framework. ` +
      `Method sources: ${refs(l, s.method_source_ids)}`
    );
  }
  const st = pack.lifecycle_stages.find((x) => x.stage_id === id);
  if (!st) throw new Error(`knowledge pack: unknown stage ${id}`);
  return (
    `# ${st.name}\n\nEvidence type: editorial stage and mentorship recommendation, not a prescribed universal ` +
    `sequence.\n\nObjective: ${st.objective}\n\nChallenges: ${st.common_challenges.join('; ')}.\n\n` +
    `Mentors: ${st.mentorship_needed.join('; ')}.\n\nOutputs: ${st.expected_outputs}\n\n` +
    `Review before progressing: ${st.progression_evidence}\n\nMethod references: ${refs(l, st.source_ids)}`
  );
}

/** The template without its "# Title" line. */
function withoutTitle(text: string): string {
  return text.replace(/^# [^\n]*\n\n/, '');
}

/** The References section: every source with its bibliographic details, URL and the audit's limitation. */
function references(
  l: Lookup,
  groups: readonly { label: string; ids: readonly string[] }[],
  scope: string,
): string {
  const lines = ['## References', '', scope];
  for (const group of groups) {
    if (group.ids.length === 0) continue;
    lines.push('', `${group.label}:`, '');
    for (const id of group.ids) {
      const s = source(l, id);
      const a = l.audit.get(id);
      const reviewed = a ? ` Reviewed ${a.checked_date}: ${a.limitation}` : '';
      lines.push(
        `- ${id}: [${s.title}](${s.url}). ${s.authors}. ${s.publisher}, ${s.publication_year}. ` +
          `${s.publication}.${reviewed}`,
      );
    }
  }
  return tidy(lines.join('\n'));
}

/** The last date the item's references were reviewed (the pack's source audit). */
function lastReviewed(pack: KnowledgePack, l: Lookup, ids: readonly string[]): string {
  const dates = ids.map((id) => l.audit.get(id)?.checked_date ?? pack.metadata.created_date).sort();
  return dates.at(-1) ?? pack.metadata.created_date;
}

function checksum(pack: KnowledgePack, item: Omit<PackItem, 'checksum'>): string {
  const material = JSON.stringify([item.title, item.body, item.freshnessAt, item.passages]);
  return `skb@${pack.metadata.schema_version}:sha256:${sha256Hex(material)}`;
}

function frameworkItem(
  pack: KnowledgePack,
  l: Lookup,
  f: PackFramework,
): Omit<PackItem, 'checksum' | 'ragDocId'> {
  const summary = tidy(ragTemplate(pack, 'framework', f.framework_id));
  const scope = `Output: ${f.expected_output}\n\nEvidence scope: ${f.evidence_note}`;
  const body = [
    summary,
    `## Output and evidence scope\n\n${scope}`,
    references(l, [{ label: 'Method references', ids: f.source_ids }], f.evidence_note),
  ].join('\n\n');
  return {
    key: `framework/${f.framework_id}`,
    kind: 'framework',
    uri: `${PACK_URI_PREFIX}framework/${f.framework_id}`,
    title: safeTitle(`${f.name} (framework)`),
    body,
    passages: [
      {
        heading: `Framework summary · sources: ${publishers(l, f.source_ids)}`,
        content: withoutTitle(summary),
        epistemic: 'method_summary',
      },
      { heading: 'Output and evidence scope', content: scope, epistemic: 'editorial_guidance' },
    ],
    freshnessAt: lastReviewed(pack, l, f.source_ids),
    sourceIds: f.source_ids,
  };
}

function caseItem(pack: KnowledgePack, l: Lookup, s: PackScenario): Omit<PackItem, 'checksum' | 'ragDocId'> {
  const text = tidy(ragTemplate(pack, 'case', s.scenario_id));
  const [, documented = '', editorial = ''] = text.split(/\n\n## [^\n]*\n\n/);
  const links = pack.scenario_framework_links.filter((x) => x.scenario_id === s.scenario_id);
  const options =
    `Possible solutions for a founder facing a similar problem (editorial, not company actions): ` +
    `${tidy(`${s.possible_solutions.join('; ')}.`)}\n\n` +
    `Frameworks (editorial mapping, not a claim the company used them): ` +
    links
      .map(
        (x) =>
          `${x.framework_id} ${l.frameworks.get(x.framework_id)?.name ?? x.framework_id}: ${x.application}`,
      )
      .join(' ');
  const body = [
    text,
    `## Options a founder might weigh (editorial)\n\n${options}`,
    references(
      l,
      [
        { label: 'Case references (support the documented account only)', ids: s.case_source_ids },
        { label: 'Method references (support the editorial analysis)', ids: s.method_source_ids },
      ],
      `${s.source_scope} Case period: ${s.case_period}. Evidence as of ${s.evidence_as_of} ` +
        `(${s.evidence_date_precision} precision).`,
    ),
  ].join('\n\n');
  return {
    key: `case/${s.scenario_id}`,
    kind: 'case',
    uri: `${PACK_URI_PREFIX}case/${s.scenario_id}`,
    title: safeTitle(s.title),
    body,
    passages: [
      {
        heading: `${DOCUMENTED_ACCOUNT_HEADING} · ${publishers(l, s.case_source_ids)}, evidence as of ${s.evidence_as_of}`,
        content: documented,
        epistemic: 'documented_account',
      },
      {
        heading: 'Editorial guidance, not company actions',
        content: editorial,
        epistemic: 'editorial_guidance',
      },
      {
        heading: 'Options a founder might weigh (editorial)',
        content: options,
        epistemic: 'editorial_guidance',
      },
    ],
    freshnessAt: lastReviewed(pack, l, s.case_source_ids),
    sourceIds: [...s.case_source_ids, ...s.method_source_ids],
  };
}

function stageItem(pack: KnowledgePack, l: Lookup, st: PackStage): Omit<PackItem, 'checksum' | 'ragDocId'> {
  const guide = tidy(ragTemplate(pack, 'stage', st.stage_id));
  const frameworks = st.framework_ids.map((id) => `${id} ${l.frameworks.get(id)?.name ?? id}`).join('; ');
  const body = [
    guide,
    references(
      l,
      [{ label: 'Method references', ids: st.source_ids }],
      `${st.evidence_note} Frameworks this stage draws on (editorial): ${frameworks}.`,
    ),
  ].join('\n\n');
  return {
    key: `stage/${st.stage_id}`,
    kind: 'stage',
    uri: `${PACK_URI_PREFIX}stage/${st.stage_id}`,
    title: safeTitle(`${st.name} (startup stage guide)`),
    body,
    passages: [
      {
        heading: 'Stage guide (editorial recommendation)',
        content: withoutTitle(guide),
        epistemic: 'editorial_guidance',
      },
    ],
    freshnessAt: lastReviewed(pack, l, st.source_ids),
    sourceIds: st.source_ids,
  };
}

/**
 * Every item of the pack, in a stable order (frameworks, cases, stages). Throws when a RAG document of the pack is
 * not reproduced by exactly one item's {@link ragTemplate}: then the templates drifted from the pack's builder.
 */
export function packItems(pack: KnowledgePack): PackItem[] {
  const l = lookup(pack);
  const drafts: { draft: Omit<PackItem, 'checksum' | 'ragDocId'>; rag: string }[] = [
    ...pack.frameworks.map((f) => ({
      draft: frameworkItem(pack, l, f),
      rag: ragTemplate(pack, 'framework', f.framework_id),
    })),
    ...pack.scenarios.map((s) => ({
      draft: caseItem(pack, l, s),
      rag: ragTemplate(pack, 'case', s.scenario_id),
    })),
    ...pack.lifecycle_stages.map((st) => ({
      draft: stageItem(pack, l, st),
      rag: ragTemplate(pack, 'stage', st.stage_id),
    })),
  ];
  const byHash = new Map<string, string[]>();
  for (const { draft, rag } of drafts) {
    const h = sha256Hex(rag);
    byHash.set(h, [...(byHash.get(h) ?? []), draft.key]);
  }
  const ragOf = new Map<string, string>();
  for (const chunk of pack.rag_chunks) {
    const keys = byHash.get(chunk.content_sha256) ?? [];
    if (keys.length !== 1 || keys[0] === undefined) {
      throw new Error(`knowledge pack: RAG document ${chunk.doc_id} is not reproduced by exactly one item`);
    }
    ragOf.set(keys[0], chunk.doc_id);
  }
  return drafts.map(({ draft }) => {
    const item = { ...draft, ragDocId: ragOf.get(draft.key) ?? null };
    return { ...item, checksum: checksum(pack, item) };
  });
}
