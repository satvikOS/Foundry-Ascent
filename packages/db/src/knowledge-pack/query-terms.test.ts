import { describe, expect, it } from 'vitest';

import { namedTermGroups, queryTermGroups, subjectTermGroups } from './query-terms.js';

describe('the words of a message that name one thing', () => {
  it('are curated names and acronyms as the founder wrote them', () => {
    expect(namedTermGroups('Can I patent it before we form an LLC?')).toEqual([
      'patent',
      'llc or "limited liability company"',
    ]);
    expect(namedTermGroups('what is a SAFE')).toEqual(['safe']);
    expect(namedTermGroups('should we join I-Corps or NSF something')).toEqual(['corps', 'nsf']);
    expect(namedTermGroups('our CRM and ERP')).toEqual(['crm', 'erp']);
  });

  it('are never everyday words, nor every word of someone who shouts', () => {
    expect(namedTermGroups('is it safe to share my idea with friends')).toEqual([]);
    expect(namedTermGroups('one sec, my friend sam said yes')).toEqual([]);
    expect(namedTermGroups('HELP ME PRICE THIS PIZZA')).toEqual([]);
    expect(namedTermGroups('')).toEqual([]);
  });

  it('are entries of the message’s words', () => {
    const text = 'do we need an EIN or a DBA for the LLC';
    for (const group of namedTermGroups(text)) expect(queryTermGroups(text)).toContain(group);
  });
});

describe('what a message is about beside the words every venture uses', () => {
  it('leaves out the platform’s own words', () => {
    expect(subjectTermGroups('a late-night pizza delivery app for students on campus')).toEqual([
      'night',
      'pizza',
      'delivery',
    ]);
    expect(subjectTermGroups('my startup idea')).toEqual([]);
  });

  it('never reads a trade name as any business at all', () => {
    // "doing business as" is the word "business" to the text search: a resource tagged business-model matched it.
    expect(queryTermGroups('what is a DBA')).toEqual(['dba or "trade name"']);
  });
});
