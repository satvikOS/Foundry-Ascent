import { describe, expect, it } from 'vitest';

import { ModelOutputInvalidError } from './errors.js';
import {
  EMBEDDING_BATCH,
  EMBEDDING_SIZES,
  embeddingBody,
  embeddingFamily,
  parseEmbeddings,
  parseRerank,
  rerankBody,
} from './retrieval-models.js';

const TITAN = 'amazon.titan-embed-text-v2:0';
const COHERE = 'us.cohere.embed-v4:0';
const NOVA = 'amazon.nova-2-multimodal-embeddings-v1:0';
const parse = (text: string): unknown => JSON.parse(text);

describe('embedding requests', () => {
  it('knows each model family, behind a profile or not', () => {
    expect([TITAN, COHERE, 'cohere.embed-v4:0', NOVA, 'cohere.rerank-v3-5:0'].map(embeddingFamily)).toEqual([
      'titan',
      'cohere',
      'cohere',
      'nova',
      null,
    ]);
    expect(() => embeddingBody('cohere.rerank-v3-5:0', ['a'], { input: 'query', dimensions: 1024 })).toThrow(
      TypeError,
    );
  });

  it('asks each model for a query or a passage in its own words', () => {
    expect(parse(embeddingBody(TITAN, ['q'], { input: 'query', dimensions: 512 }))).toEqual({
      inputText: 'q',
      dimensions: 512,
      normalize: true,
    });
    expect(parse(embeddingBody(COHERE, ['a', 'b'], { input: 'document', dimensions: 1024 }))).toEqual({
      input_type: 'search_document',
      texts: ['a', 'b'],
      embedding_types: ['float'],
      output_dimension: 1024,
      truncate: 'RIGHT',
    });
    expect(parse(embeddingBody(COHERE, ['a'], { input: 'query', dimensions: 256 }))).toMatchObject({
      input_type: 'search_query',
    });
    expect(parse(embeddingBody(NOVA, ['a'], { input: 'query', dimensions: 1024 }))).toEqual({
      schemaVersion: 'nova-multimodal-embed-v1',
      taskType: 'SINGLE_EMBEDDING',
      singleEmbeddingParams: {
        embeddingPurpose: 'TEXT_RETRIEVAL',
        embeddingDimension: 1024,
        text: { truncationMode: 'END', value: 'a' },
      },
    });
    expect(parse(embeddingBody(NOVA, ['a'], { input: 'document', dimensions: 256 }))).toMatchObject({
      singleEmbeddingParams: { embeddingPurpose: 'GENERIC_INDEX' },
    });
  });

  it('refuses a size the model does not offer, an empty text and more than a batch', () => {
    expect(EMBEDDING_SIZES.titan).toEqual([256, 512, 1024]);
    expect(EMBEDDING_BATCH).toEqual({ titan: 1, cohere: 96, nova: 1 });
    for (const call of [
      () => embeddingBody(TITAN, ['a'], { input: 'query', dimensions: 1536 }),
      () => embeddingBody(TITAN, ['a', 'b'], { input: 'query', dimensions: 1024 }),
      () => embeddingBody(COHERE, ['  '], { input: 'query', dimensions: 1024 }),
      () => embeddingBody(COHERE, [], { input: 'query', dimensions: 1024 }),
    ]) {
      expect(call).toThrow(RangeError);
    }
  });
});

describe('embedding responses', () => {
  const two = { count: 2, dimensions: 256 };
  const vector = (x: number): number[] => Array.from({ length: 256 }, () => x);

  it('reads each model family', () => {
    const one = { count: 1, dimensions: 256 };
    expect(
      parseEmbeddings(TITAN, JSON.stringify({ embedding: vector(1), inputTextTokenCount: 7 }), one),
    ).toEqual({ vectors: [vector(1)], inputTokens: 7 });
    for (const embeddings of [[vector(1), vector(2)], { float: [vector(1), vector(2)] }]) {
      expect(parseEmbeddings(COHERE, JSON.stringify({ embeddings }), two)).toEqual({
        vectors: [vector(1), vector(2)],
        inputTokens: null,
      });
    }
    expect(
      parseEmbeddings(
        NOVA,
        JSON.stringify({ embeddings: [{ embeddingType: 'TEXT', embedding: vector(3) }] }),
        one,
      ).vectors,
    ).toEqual([vector(3)]);
  });

  it.each([
    ['not json', 'nope'],
    ['a missing vector', JSON.stringify({ embeddings: [vector(1)] })],
    ['a short vector', JSON.stringify({ embeddings: [vector(1), [1]] })],
    ['a value that is no number', JSON.stringify({ embeddings: [vector(1), [...vector(1).slice(1), 'x']] })],
    ['no embeddings', JSON.stringify({})],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseEmbeddings(COHERE, raw, two)).toThrow(ModelOutputInvalidError);
  });
});

describe('rerankers', () => {
  it('writes the request, with the API version Cohere needs', () => {
    expect(parse(rerankBody('cohere.rerank-v3-5:0', 'q', ['a', 'b']))).toEqual({
      query: 'q',
      documents: ['a', 'b'],
      top_n: 2,
      api_version: 2,
    });
    expect(parse(rerankBody('amazon.rerank-v1:0', 'q', ['a']))).toEqual({
      query: 'q',
      documents: ['a'],
      top_n: 1,
    });
  });

  it('reads the order, best first, and refuses an answer that is none', () => {
    const answer = (results: unknown): string => JSON.stringify({ results });
    expect(
      parseRerank(
        'cohere.rerank-v3-5:0',
        answer([
          { index: 1, relevance_score: 0.2 },
          { index: 0, relevance_score: 0.9 },
        ]),
        2,
      ),
    ).toEqual([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.2 },
    ]);
    expect(parseRerank('amazon.rerank-v1:0', answer([{ index: 0, relevanceScore: 0.5 }]), 1)).toEqual([
      { index: 0, score: 0.5 },
    ]);
    for (const bad of [
      'no',
      answer([]),
      answer([{ index: 2, relevance_score: 1 }]),
      answer([{ index: 0 }]),
      answer([
        { index: 0, relevance_score: 1 },
        { index: 0, relevance_score: 1 },
      ]),
    ]) {
      expect(() => parseRerank('amazon.rerank-v1:0', bad, 2)).toThrow(ModelOutputInvalidError);
    }
  });
});
