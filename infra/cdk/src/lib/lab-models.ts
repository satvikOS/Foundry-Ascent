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
  embeddingsAccess,
  foundationModelId,
  isGlobalInferenceProfile,
  isInferenceProfile,
  isMantleModel,
  reasoningAccess,
  type BedrockRuntimeAccess,
  type EffectiveModels,
} from './models.js';

export const LAB_MODELS_FILE = join(REPO_ROOT, 'ops', 'lab', 'models.json');

export interface LabModels {
  readonly simulator: readonly string[];
  readonly judge: readonly string[];
  /** Foundation-model id → USD per million input / output tokens (what the lab meters its own calls at). */
  readonly usdPerMillionTokens: Readonly<Record<string, { readonly input: number; readonly output: number }>>;
}

/** A Bedrock model id or inference-profile id: `amazon.nova-pro-v1:0`, `us.amazon.nova-pro-v1:0`. */
const MODEL_ID = /^(?:(?:us|global)\.)?[a-z0-9-]+\.[a-z0-9.-]+(?::\d+)?$/;

function fail(path: string, problem: string): never {
  throw new Error(`${LAB_MODELS_FILE}: ${path} ${problem}`);
}

function modelList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3)
    fail(path, 'must list 1 to 3 model ids');
  return value.map((id, index) => {
    if (typeof id !== 'string' || !MODEL_ID.test(id))
      fail(`${path}[${String(index)}]`, 'is not a Bedrock model id');
    // The OpenAI-compatible Mantle endpoint needs bedrock-mantle:CreateInference on *, which the lab role never gets.
    if (isMantleModel(id)) fail(`${path}[${String(index)}]`, 'is a Mantle model; the lab uses Converse only');
    return id;
  });
}

export function parseLabModels(raw: unknown): LabModels {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('$', 'must be an object');
  const root = raw as Record<string, unknown>;
  const simulator = modelList(root.simulator, '$.simulator');
  const judge = modelList(root.judge, '$.judge');
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
  for (const id of [...simulator, ...judge]) {
    if (!Object.hasOwn(usdPerMillionTokens, foundationModelId(id)))
      fail('$.usdPerMillionTokens', `has no price for ${foundationModelId(id)}`);
  }
  return { simulator, judge, usdPerMillionTokens };
}

export const LAB_MODELS: LabModels = parseLabModels(
  JSON.parse(readFileSync(LAB_MODELS_FILE, 'utf8')) as unknown,
);

/**
 * Every Bedrock resource the lab invokes: the app's effective reasoning and embeddings models (it runs the app
 * with the production model configuration) and the lab's simulator and judge models.
 */
export function conversationLabAccess(app: EffectiveModels, lab: LabModels): BedrockRuntimeAccess {
  const own = [...lab.simulator, ...lab.judge];
  const parts = [reasoningAccess(app), embeddingsAccess(app)];
  const ownAccess: BedrockRuntimeAccess = {
    foundationModels: own.map(foundationModelId),
    globalFoundationModels: own.filter(isGlobalInferenceProfile).map(foundationModelId),
    inferenceProfiles: own.filter(isInferenceProfile),
  };
  const merge = (pick: (access: BedrockRuntimeAccess) => readonly string[]): string[] => [
    ...new Set([...parts, ownAccess].flatMap(pick)),
  ];
  return {
    foundationModels: merge((a) => a.foundationModels),
    globalFoundationModels: merge((a) => a.globalFoundationModels),
    inferenceProfiles: merge((a) => a.inferenceProfiles),
  };
}
