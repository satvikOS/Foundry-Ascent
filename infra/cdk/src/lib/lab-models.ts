/**
 * The conversation lab's own models (`ops/lab/models.json`): the LLM that plays the founder (simulator) and the
 * one that grades conversations (judge), each a list tried in order. The lab role
 * (FoundryAscent-ConversationLab, foundation-stack.ts) may invoke exactly these and the app's effective models,
 * nothing else. Validated at synth time, so a typo cannot widen or silently break the grant.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../paths.js';
import {
  foundationModelId,
  isInferenceProfile,
  isMantleModel,
  reasoningAccess,
  reasoningModelIds,
  runtimeAccess,
  type BedrockRuntimeAccess,
  type EffectiveModels,
} from './models.js';

export const LAB_MODELS_FILE = join(REPO_ROOT, 'ops', 'lab', 'models.json');

export interface LabModels {
  readonly simulator: readonly string[];
  readonly judge: readonly string[];
  /**
   * The live evaluation's own candidates (`live` in models.json): a student simulator and a judge from model
   * families other than the app's, falling back to Nova. Empty when the file has no `live` section.
   */
  readonly live: {
    readonly simulator: readonly string[];
    readonly judge: readonly string[];
    /**
     * Alternative coach models a lab run may put the app's coach on for an A/B (`coach_model` of ops-live-evals.yml):
     * the lab's API process only, never production's configuration. Empty when absent.
     */
    readonly coach: readonly string[];
  };
  /**
   * The client suite's own (`client` in models.json; ops/lab conversation_lab/client): its judges, and the coach models
   * its runs may put the lab's API process on. Empty when the file has no section.
   */
  readonly client: { readonly judge: readonly string[]; readonly coach: readonly string[] };
  /**
   * The models the understand call of a turn is compared on (`understand` in models.json; ops/lab
   * conversation_lab/understand_bench.py), and the client suite's `understand_model`. Empty when the file has no section.
   */
  readonly understand: readonly string[];
  /**
   * The models suite's candidates (`benchmark` in models.json; ops/lab conversation_lab/models_bench.py): reasoning
   * models, embedding models and rerankers compared before the app uses any. Empty when the file has no section.
   */
  readonly benchmark: {
    readonly reasoning: readonly string[];
    readonly embeddings: readonly string[];
    readonly rerankers: readonly { readonly id: string; readonly region: string }[];
  };
  /** Foundation-model id → USD per million input / output tokens (what the lab meters its own calls at). */
  readonly usdPerMillionTokens: Readonly<Record<string, { readonly input: number; readonly output: number }>>;
}

/** A Bedrock model id or inference-profile id: `amazon.nova-pro-v1:0`, `us.amazon.nova-pro-v1:0`. */
const MODEL_ID = /^(?:(?:us|global)\.)?[a-z0-9-]+\.[a-z0-9.-]+(?::\d+)?$/;

function fail(path: string, problem: string): never {
  throw new Error(`${LAB_MODELS_FILE}: ${path} ${problem}`);
}

function modelList(value: unknown, path: string, max = 3): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max)
    fail(path, `must list 1 to ${String(max)} model ids`);
  return value.map((id, index) => {
    if (typeof id !== 'string' || !MODEL_ID.test(id))
      fail(`${path}[${String(index)}]`, 'is not a Bedrock model id');
    // The OpenAI-compatible Mantle endpoint needs bedrock-mantle:CreateInference on *, which the lab role never gets.
    if (isMantleModel(id)) fail(`${path}[${String(index)}]`, 'is a Mantle model; the lab uses Converse only');
    return id;
  });
}

/** A list of candidates of the `benchmark` section: at most `max` objects, each with a unique `id` and what `read` adds. */
function candidates<T>(
  value: unknown,
  path: string,
  max: number,
  read: (item: Record<string, unknown>, id: string, path: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max)
    fail(path, `must list 1 to ${String(max)} candidates`);
  const ids = new Set<string>();
  return value.map((item: unknown, index) => {
    const at = `${path}[${String(index)}]`;
    const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const [id] = modelList([record.id], at);
    if (id === undefined || ids.has(id)) fail(at, 'repeats a model id');
    ids.add(id);
    return read(record, id, at);
  });
}

function parseBenchmark(raw: unknown): LabModels['benchmark'] {
  if (raw === undefined) return { reasoning: [], embeddings: [], rerankers: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('$.benchmark', 'must be an object');
  const b = raw as Record<string, unknown>;
  const id = (_item: Record<string, unknown>, modelId: string): string => modelId;
  return {
    reasoning: candidates(b.reasoning, '$.benchmark.reasoning', 12, id),
    embeddings: candidates(b.embeddings, '$.benchmark.embeddings', 6, id),
    rerankers: candidates(b.rerankers, '$.benchmark.rerankers', 4, (item, modelId, at) => {
      const { region } = item;
      if (typeof region !== 'string' || !/^us-(?:east|west)-\d$/.test(region))
        fail(`${at}.region`, 'must be a US region');
      return { id: modelId, region };
    }),
  };
}

export function parseLabModels(raw: unknown): LabModels {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('$', 'must be an object');
  const root = raw as Record<string, unknown>;
  const simulator = modelList(root.simulator, '$.simulator');
  const judge = modelList(root.judge, '$.judge');
  let live: LabModels['live'] = { simulator: [], judge: [], coach: [] };
  if (root.live !== undefined) {
    if (typeof root.live !== 'object' || root.live === null || Array.isArray(root.live))
      fail('$.live', 'must be an object');
    const l = root.live as Record<string, unknown>;
    live = {
      simulator: modelList(l.simulator, '$.live.simulator'),
      judge: modelList(l.judge, '$.live.judge'),
      coach: l.coach === undefined ? [] : modelList(l.coach, '$.live.coach'),
    };
  }
  let client: LabModels['client'] = { judge: [], coach: [] };
  if (root.client !== undefined) {
    if (typeof root.client !== 'object' || root.client === null || Array.isArray(root.client))
      fail('$.client', 'must be an object');
    const c = root.client as Record<string, unknown>;
    client = {
      judge: modelList(c.judge, '$.client.judge'),
      coach: modelList(c.coach, '$.client.coach', 10),
    };
  }
  const understand =
    root.understand === undefined
      ? []
      : candidates(root.understand, '$.understand', 8, (_item, modelId) => modelId);
  const prices = root.usdPerMillionTokens;
  if (typeof prices !== 'object' || prices === null || Array.isArray(prices))
    fail('$.usdPerMillionTokens', 'must be an object');
  const usdPerMillionTokens: Record<string, { input: number; output: number }> = {};
  for (const [id, price] of Object.entries(prices as Record<string, unknown>)) {
    const p = price as { input?: unknown; output?: unknown } | null;
    if (
      typeof p !== 'object' ||
      p === null ||
      typeof p.input !== 'number' ||
      typeof p.output !== 'number' ||
      !(p.input > 0) ||
      !(p.output >= 0)
    ) {
      fail(`$.usdPerMillionTokens.${id}`, 'must have a positive input and a non-negative output price');
    }
    usdPerMillionTokens[id] = { input: p.input, output: p.output };
  }
  for (const id of [
    ...simulator,
    ...judge,
    ...live.simulator,
    ...live.judge,
    ...live.coach,
    ...client.judge,
    ...client.coach,
    ...understand,
  ]) {
    if (!Object.hasOwn(usdPerMillionTokens, foundationModelId(id)))
      fail('$.usdPerMillionTokens', `has no price for ${foundationModelId(id)}`);
  }
  return {
    simulator,
    judge,
    live,
    client,
    understand,
    benchmark: parseBenchmark(root.benchmark),
    usdPerMillionTokens,
  };
}

export const LAB_MODELS: LabModels = parseLabModels(
  JSON.parse(readFileSync(LAB_MODELS_FILE, 'utf8')) as unknown,
);

/**
 * Every Bedrock resource the lab invokes: the app's effective reasoning and embeddings models (it runs the app
 * with the production model configuration) and the lab's simulator and judge models, the live evaluation's included,
 * the alternative coach models a lab run may run the app's coach on (`live.coach`, `client.coach`: an A/B, the lab
 * only), the client suite's judges, the understand suite's candidates (`understand`) and the models suite's (`benchmark`). Each foundation model is granted where its profiles route (lib/models.ts
 * `runtimeAccess`), the widest of its ways in; a reranker, and a coach or reasoning candidate with no profile (served in
 * region: gpt-oss, Qwen, DeepSeek, Mistral), only in the region it is called in.
 */
export function conversationLabAccess(
  app: EffectiveModels,
  lab: LabModels,
  region = 'us-east-1',
): BedrockRuntimeAccess {
  const candidates = [...lab.live.coach, ...lab.client.coach, ...lab.understand, ...lab.benchmark.reasoning];
  const inRegion = [...new Set(candidates.filter((id) => !isInferenceProfile(id)))];
  const own = [
    ...lab.simulator,
    ...lab.judge,
    ...lab.live.simulator,
    ...lab.live.judge,
    ...lab.client.judge,
    ...candidates.filter(isInferenceProfile),
    ...lab.benchmark.embeddings,
  ];
  const appAccess = reasoningAccess(app, region);
  const all = runtimeAccess(
    [...reasoningModelIds(app).filter((id) => !isMantleModel(id)), app.embeddings, ...own],
    region,
  );
  // One entry per foundation model, its regions merged: a candidate the app also calls in region (the coach, Mistral
  // Large 3; the SUMS part's gpt-oss-120b) is listed once.
  const regional = new Map<string, Set<string>>();
  const grant = (modelId: string, regions: readonly string[]): void => {
    const known = regional.get(modelId) ?? new Set<string>();
    for (const r of regions) known.add(r);
    regional.set(modelId, known);
  };
  for (const { modelId, regions } of all.regionalFoundationModels) grant(modelId, regions);
  for (const id of inRegion.filter((id) => !all.foundationModels.includes(id))) grant(id, [region]);
  for (const { id, region: where } of lab.benchmark.rerankers) grant(id, [where]);
  return {
    ...all,
    regionalFoundationModels: [...regional].map(([modelId, regions]) => ({
      modelId,
      regions: [...regions].sort(),
    })),
    // A bare reasoning id's `us.` retry profile (reasoningAccess) comes with it.
    inferenceProfiles: [...new Set([...all.inferenceProfiles, ...appAccess.inferenceProfiles])],
  };
}
