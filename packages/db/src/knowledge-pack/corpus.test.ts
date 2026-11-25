/** The cited corpus as data: every note short, located, licensed and gated; nobody named; nothing copied in length. */
import { describe, expect, it } from 'vitest';

import { PROGRAMME_NOTES } from '../seed/programme-notes.js';
import {
  CORPUS,
  corpusBody,
  corpusChecksum,
  corpusUrisForCitations,
  corpusUrisForMessage,
  corpusUrisForTopics,
  LIBRARY_URI_PREFIX,
  MAX_NOTE_CHARS,
  OPEN_LIBRARY,
  pinnedNote,
  PROGRAMME_NOTES_URI_PREFIX,
} from './corpus.js';
import { contentTerms, MAX_QUERY_TERMS, queryTermGroups } from './query-terms.js';
import { CORPUS_TOPICS, corpusTopics, seeksHelp } from './topics.js';

describe('the cited corpus', () => {
  it('holds short notes, each with a place, a page, a licence and an attribution', () => {
    expect(PROGRAMME_NOTES.reduce((n, s) => n + s.notes.length, 0)).toBeGreaterThanOrEqual(40);
    expect(PROGRAMME_NOTES.reduce((n, s) => n + s.notes.length, 0)).toBeLessThanOrEqual(70);
    expect(new Set(CORPUS.map((s) => s.uri)).size).toBe(CORPUS.length);
    for (const source of CORPUS) {
      expect(source.url, source.key).toMatch(
        /^https:\/\/(?:[a-z.]+\.)?(?:rochester\.edu|sba\.gov|uspto\.gov|irs\.gov|sec\.gov|nsf\.gov|usask\.ca)\//,
      );
      expect(source.licence.length, source.key).toBeGreaterThan(5);
      expect(source.attribution.length, source.key).toBeGreaterThan(10);
      expect(source.accessedOn).toMatch(/^2026-\d\d-\d\d$/);
      expect(source.topics.length, source.key).toBeGreaterThan(0);
      expect(source.notes.length, source.key).toBeGreaterThan(0);
      expect(corpusBody(source)).toContain(source.url);
      for (const note of source.notes) {
        expect(note.content.length, note.heading).toBeLessThanOrEqual(MAX_NOTE_CHARS);
        expect(note.content.length, note.heading).toBeGreaterThan(80);
        expect(note.locator.length, note.heading).toBeGreaterThan(3);
        expect(`${note.content}${note.heading}`, note.heading).not.toMatch(/[—–]/);
      }
    }
  });

  it('names no presenter, no presenter’s company and no film-by-film biography', () => {
    const text = JSON.stringify(PROGRAMME_NOTES);
    for (const name of [
      'Testa',
      'Mammano',
      'Shifat',
      'Sharfuz',
      'Avanti',
      'Gonzo',
      'Crossroads',
      'Hitachi',
      'Careers Uncorked',
      'Square One',
    ])
      expect(text).not.toContain(name);
    for (const note of PROGRAMME_NOTES.flatMap((s) => s.notes))
      expect(note.locator).toMatch(/^Module [123], Unit [12], .+, \d\d:\d\d to \d\d:\d\d$/);
  });

  it('says who decides first, in every note about law, tax or securities that asks for a decision', () => {
    for (const heading of [
      'Who decides the legal structure',
      'A DBA is the quickest start, without protection',
      'Structures to look into',
      'Legal structure when you plan to raise money',
      'Get advice before asking anyone for money',
      'Convertible debt in plain words',
      'What a provisional patent application does',
      'Public disclosure and the one-year clock',
      'Selling shares: registered or exempt',
      'Rule 506(b): private offering, no advertising',
      'Rule 506(c): advertising, accredited investors only',
      'Equity crowdfunding rules',
      'What counts as general solicitation',
      'When self-employment income must be reported',
    ]) {
      const note = CORPUS.flatMap((s) => s.notes).find((n) => n.heading === heading);
      expect(note, heading).toBeDefined();
      expect(note?.content.slice(0, 120), heading).toMatch(
        /\b(?:lawyer|attorney|accountant|advice|tax professional|county clerk)\b/i,
      );
    }
  });

  it('keeps the ShareAlike notice with every note adapted from a CC BY-SA book', () => {
    const books = OPEN_LIBRARY.filter((s) => s.key.startsWith('swanson-'));
    expect(books.length).toBeGreaterThan(0);
    for (const book of books) {
      expect(book.licence).toBe('CC BY-SA 4.0');
      expect(book.attribution).toContain('Lee A. Swanson');
      expect(book.attribution).toContain('this note is under CC BY-SA 4.0');
    }
    // Every other source is a U.S. government page.
    for (const s of OPEN_LIBRARY.filter((x) => !x.key.startsWith('swanson-')))
      expect(new URL(s.url).hostname, s.key).toMatch(/\.gov$/);
  });

  it('is under its own uris, and a changed note changes the checksum', () => {
    for (const s of PROGRAMME_NOTES) expect(s.uri.startsWith(PROGRAMME_NOTES_URI_PREFIX)).toBe(true);
    for (const s of OPEN_LIBRARY) expect(s.uri.startsWith(LIBRARY_URI_PREFIX)).toBe(true);
    const first = OPEN_LIBRARY[0];
    if (first === undefined) throw new Error('empty library');
    const edited = { ...first, notes: first.notes.map((n, i) => (i === 0 ? { ...n, content: 'x' } : n)) };
    expect(corpusChecksum(edited)).not.toBe(corpusChecksum(first));
    expect(corpusChecksum({ ...first })).toBe(corpusChecksum(first));
  });
});

describe('what a message asks the corpus for', () => {
  it('names the topics of the client’s questions', () => {
    for (const [text, topic] of [
      ['Who is my customer and who is my user?', 'customer-user'],
      ['Should I form an LLC?', 'legal-structure'],
      ['How do I fill in the Business Model Canvas?', 'canvas'],
      ['What should my pitch deck include?', 'pitch'],
      ['Should I raise money or bootstrap?', 'bootstrapping'],
      ['Should I raise money or bootstrap?', 'fundraising'],
      ['How do I talk to potential customers?', 'customer-discovery'],
      ['I need help with networking', 'networking'],
      ['How do I make money with a free app?', 'business-model'],
      ['Can I patent this?', 'patent'],
    ] as const)
      expect(corpusTopics(text), text).toContain(topic);
  });

  it('reads a message that only tells as asking nothing', () => {
    for (const text of [
      'I emailed the three owners this morning.',
      'Our pitch went well and the investors smiled.',
      'We registered the LLC yesterday.',
      'ok',
      '',
    ]) {
      expect(corpusTopics(text), text).toEqual([]);
      expect(seeksHelp(text), text).toBe(false);
      expect(corpusUrisForMessage(text), text).toEqual([]);
    }
    // What is said right before a question is what it is about.
    expect(corpusTopics('We formed an LLC. What now?')).toContain('legal-structure');
    expect(corpusTopics('The pitch went well. Then we had pizza. What time is it?')).not.toContain('pitch');
  });

  it('gives every topic a source, and knows only its own topics', () => {
    for (const topic of CORPUS_TOPICS) expect(corpusUrisForTopics([topic]).length, topic).toBeGreaterThan(0);
  });

  it('finds the sources a play’s citations mean', () => {
    expect(corpusUrisForCitations([{ sourceId: 'uspto-provisional', locator: null }])).toEqual([
      ['library:uspto-provisional'],
    ]);
    // A book under copyright is cited by the play alone.
    expect(corpusUrisForCitations([{ sourceId: 'mom-test', locator: 'Chapter 1' }])).toEqual([]);
    // The programme is one source to the playbook: a named unit says which notes, none named means none.
    expect(
      corpusUrisForCitations([{ sourceId: 'ain-curriculum', locator: 'Module 2, Unit 1: Legal structure' }]),
    ).toEqual([['curriculum:notes/m2u1-legal-structure', 'curriculum:notes/m2u1-customer-discovery']]);
    expect(corpusUrisForCitations([{ sourceId: 'ain-curriculum', locator: null }])).toEqual([]);
  });
});

describe('the note a play’s citation pins', () => {
  const networking = [{ sourceId: 'ain-foundry', locator: 'Module 3, Unit 2: Networking I' }];

  it('is the one note most about the play itself', () => {
    expect(
      pinnedNote({
        title: 'Send 10 short emails, each with its own first line',
        text: 'One line on why them, one on the problem, one ask for 15 minutes. Keep the email short; nobody reads a long paragraph.',
        citations: [{ sourceId: 'ain-foundry', locator: 'Module 3, Unit 2: Networking II' }],
      }),
    ).toEqual({ uri: 'curriculum:notes/m3u2-networking-2', ordinal: 4 });
    expect(
      pinnedNote({
        title: 'File a patent now or wait',
        text: 'A public disclosure starts a one-year clock; a provisional application holds your date. See a patent attorney.',
        citations: [
          { sourceId: 'mom-test', locator: 'Chapter 1' },
          { sourceId: 'uspto-provisional', locator: null },
        ],
      }),
    ).toEqual({ uri: 'library:uspto-provisional', ordinal: 4 });
  });

  it('is none when the cited unit has no note about the play', () => {
    // A client's run: a Networking note was pinned, and cited, for "Tell me my idea is great".
    expect(
      pinnedNote({
        title: 'Write how many strangers must pay, then test it',
        text: 'I will not call it great, because neither of us knows yet. Great is what strangers show with their money. Its strength is whatever you have seen people do about the problem so far. Prove it with 10 sales to strangers this month.',
        citations: networking,
      }),
    ).toBeNull();
    expect(pinnedNote({ title: 'Any', text: 'Any', citations: [] })).toBeNull();
    expect(
      pinnedNote({ title: 'Any', text: 'Any', citations: [{ sourceId: 'mom-test', locator: null }] }),
    ).toBeNull();
  });
});

describe('the content of a message', () => {
  it('leaves out words that carry no subject, once each, at most the first forty', () => {
    expect(contentTerms('How do I price my pilot? My pilot is $40.')).toEqual(['price', 'pilot', '40']);
    expect(contentTerms('What should I do next?')).toEqual(['next']);
    expect(contentTerms('ok thanks')).toEqual([]);
    expect(contentTerms(Array.from({ length: 90 }, (_, i) => `word${String(i)}`).join(' '))).toHaveLength(
      MAX_QUERY_TERMS,
    );
  });

  it('reads other names of one thing as one word', () => {
    expect(queryTermGroups('a VC')).toEqual(['vc or "venture capital"']);
    expect(queryTermGroups('an LLC')).toEqual(['llc or "limited liability company"']);
  });
});
