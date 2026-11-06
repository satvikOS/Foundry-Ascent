/**
 * What names each reference-library item, curated per item (frameworks, documented cases, lifecycle stages of the
 * startup knowledge base). The relevance gate (`gate.ts`) admits an item only when the founder's own message uses
 * one of these, in the way stated for it. Rules the unit tests hold every entry to:
 *
 * - a one-word term or name is never everyday English (not among the 10,000 most frequent English words,
 *   `knowledge/common-english`); a common word may only appear inside a longer phrase, or as a paired term that
 *   needs one of its cues in the same sentence;
 * - every case lists its company's full name; a short form is listed only when it is not everyday English;
 * - a company whose name is everyday English or an everyday product ("Grove", "Embrace", "Dropbox") is `everyday`:
 *   its name counts only beside a word that shows the company is meant (`nameCues`, or a case frame such as "how did
 *   Dropbox", "the Grove case"), so "Grove Street has cheaper rent" or "the deck is on Dropbox" retrieve nothing;
 * - `nameCues` count only within a few words of the name, in the same sentence ("the Dropbox referral program");
 * - `topics` (a case's subject: "home try-on", "pet care") count only near a genuine ask for an example or case;
 * - a stage is never named by one word alone: "repeatability" is a paired term that needs a startup word.
 */

export interface PairedTerm {
  /** Words or phrases that name the subject only together with a cue. */
  readonly terms: readonly string[];
  /** Words or phrases, one of which must be in the same sentence. */
  readonly cues: readonly string[];
}

export interface ItemVocabulary {
  /** Phrases (or one word that is not everyday English) naming the item's subject; matched case-insensitively. */
  readonly terms?: readonly string[];
  /**
   * Abbreviations as written ("CAC"). Lowercase too ("cac") unless the lowercase form is everyday English or a name
   * (`caseSensitive`): "MVP" is matched as written, "mvp" only as a paired term.
   */
  readonly acronyms?: readonly string[];
  /** Acronyms matched only as written (their lowercase form is a name: "Sam", "Tam"). */
  readonly caseSensitive?: readonly string[];
  readonly paired?: readonly PairedTerm[];
  /** A documented case: the company's full name first, then safe short forms. */
  readonly names?: readonly string[];
  /** The name is everyday English or an everyday product: it counts only with a cue or in a case frame. */
  readonly everyday?: boolean;
  /** Words or phrases that show the company is meant (its product, its founders, its industry). */
  readonly nameCues?: readonly string[];
  /** A case's subject, matched only when the founder asks for an example or a case. */
  readonly topics?: readonly string[];
}

export const REFERENCE_VOCABULARY: Readonly<Record<string, ItemVocabulary>> = {
  'framework/F01': {
    terms: [
      'lean startup',
      'lean start up',
      'build measure learn',
      'validated learning',
      'minimum viable product',
      'pivot or persevere',
      'innovation accounting',
      'lean methodology',
      'eric ries',
    ],
    acronyms: ['MVP'],
    caseSensitive: ['MVP'],
    paired: [
      {
        terms: ['mvp'],
        cues: [
          'build',
          'launch',
          'test',
          'first',
          'product',
          'startup',
          'lean',
          'feature',
          'features',
          'version',
        ],
      },
    ],
  },
  'framework/F02': {
    terms: [
      'business model canvas',
      'lean canvas',
      'nine building blocks',
      'building blocks of a business model',
      'osterwalder',
      'ash maurya',
    ],
    paired: [
      { terms: ['canvas'], cues: ['business model', 'lean', 'blocks', 'boxes', 'startup', 'fill out'] },
    ],
  },
  'framework/F03': {
    terms: [
      'value proposition canvas',
      'value proposition design',
      'value map',
      'pain relievers',
      'pain reliever',
      'gain creators',
      'gain creator',
      'pains and gains',
      'jobs pains and gains',
    ],
  },
  'framework/F04': {
    terms: [
      'customer discovery',
      'customer development',
      'customer validation',
      'discovery interview',
      'steve blank',
      'get out of the building',
    ],
    // "Our customer interviews so far…" is the founder's own evidence, not a question about the method.
    paired: [
      {
        terms: ['customer interview', 'problem interview', 'user interview'],
        cues: [
          'run',
          'conduct',
          'structure',
          'script',
          'what questions',
          'which questions',
          'how many',
          'how to',
          'how do i',
          'how do we',
          'how should i',
          'how should we',
          'best way',
          'framework',
          'method',
          'guide',
        ],
      },
    ],
  },
  'framework/F05': {
    terms: [
      'design thinking',
      'human centered design',
      'human centred design',
      'empathy map',
      'empathy mapping',
      'd school',
    ],
  },
  'framework/F06': {
    terms: ['jobs to be done', 'job to be done', 'jobs theory', 'clayton christensen'],
    acronyms: ['JTBD'],
  },
  'framework/F07': {
    terms: [
      'market sizing',
      'size the market',
      'size my market',
      'size our market',
      'size a market',
      'sizing the market',
      'sizing my market',
      'sizing our market',
      'total addressable market',
      'serviceable addressable market',
      'serviceable available market',
      'serviceable obtainable market',
      'addressable market',
      'beachhead',
      'beachhead market',
    ],
    acronyms: ['TAM', 'SAM', 'SOM'],
    caseSensitive: ['TAM', 'SAM', 'SOM'],
    // "Our market size is small" states a fact; estimating it is the method.
    paired: [
      {
        terms: ['market size'],
        cues: [
          'estimate',
          'estimating',
          'calculate',
          'calculating',
          'figure out',
          'work out',
          'how big',
          'measure',
        ],
      },
    ],
  },
  'framework/F08': {
    terms: [
      'pirate metrics',
      'pirate metric',
      'activation rate',
      'funnel metrics',
      'acquisition activation retention',
      'dave mcclure',
    ],
    acronyms: ['AARRR'],
  },
  'framework/F09': {
    terms: [
      'unit economics',
      'customer acquisition cost',
      'acquisition cost',
      'acquisition costs',
      'lifetime value',
      'customer lifetime value',
      'contribution margin',
      'payback period',
      'cac payback',
    ],
    acronyms: ['CAC', 'LTV', 'CLV'],
  },
  'case/SC01': {
    names: ['NONA Technologies', 'NONA'],
    topics: ['desalination', 'portable desalination', 'water purification'],
  },
  'case/SC02': {
    names: ['PillPack'],
    topics: ['medication management', 'online pharmacy', 'pharmacy', 'prescriptions'],
  },
  'case/SC03': {
    names: ['Warby Parker', 'Warby'],
    topics: ['eyewear', 'glasses', 'home try on', 'try on at home'],
  },
  'case/SC04': {
    names: ['Tulip'],
    everyday: true,
    nameCues: ['factory', 'factories', 'manufacturing', 'frontline operations', 'manufacturing apps'],
    topics: ['factory software', 'manufacturing software', 'manufacturing apps'],
  },
  'case/SC05': {
    names: ['FarmWise'],
    topics: [
      'farm robotics',
      'agricultural robots',
      'agricultural robotics',
      'weeding robot',
      'weeding robots',
    ],
  },
  'case/SC06': {
    names: ['OpenSpace'],
    topics: ['construction site', 'construction software', 'construction sites'],
  },
  'case/SC07': {
    names: ['Wecyclers'],
    topics: ['recycling', 'waste collection'],
  },
  'case/SC08': {
    names: ['Fyto'],
    topics: ['wastewater', 'aquatic plants', 'farm wastewater'],
  },
  'case/SC09': {
    names: ['Alchemista'],
    topics: ['group meals', 'catering', 'group food orders', 'food for large groups'],
  },
  'case/SC10': {
    names: ['Locu', 'Goodplates'],
    topics: ['restaurant data', 'menu data', 'consumer app to b2b'],
  },
  'case/SC11': {
    names: ['Grove'],
    everyday: true,
    nameCues: [
      'aquaponic',
      'aquaponics',
      'indoor garden',
      'indoor gardening',
      'growing appliance',
      'grove labs',
    ],
    topics: ['indoor gardening', 'aquaponics', 'gardening hardware'],
  },
  'case/SC12': {
    names: ['Spyce'],
    topics: ['restaurant robotics', 'robotic kitchen', 'automated restaurant', 'restaurant automation'],
  },
  'case/SC13': {
    names: ['SurgiBox', 'Surgi Box'],
    topics: ['portable operating room', 'surgical device', 'medical device', 'medical devices'],
  },
  'case/SC14': {
    names: ['Formlabs'],
    topics: ['3d printing', '3d printer', '3d printers'],
  },
  'case/SC15': {
    names: ['Dropbox'],
    everyday: true,
    nameCues: [
      'drew houston',
      'arash ferdowsi',
      'flash drive',
      'flash drives',
      'referral program',
      'file sync',
    ],
    topics: ['file storage', 'file sync', 'cloud storage'],
  },
  'case/SC16': {
    names: ['Station A'],
    everyday: true,
    nameCues: ['clean energy', 'energy projects', 'solar projects', 'property owners'],
    topics: ['clean energy marketplace', 'clean energy projects'],
  },
  'case/SC17': {
    names: ['Quincy Apparel'],
    topics: ['apparel', 'clothing brand', 'fashion brand', 'clothing startup'],
  },
  'case/SC18': {
    names: ['Triangulate'],
    everyday: true,
    nameCues: ['dating', 'dating app', 'dating service', 'dating services'],
    topics: ['online dating', 'dating app', 'dating service'],
  },
  'case/SC19': {
    names: ['Baroo'],
    topics: ['pet care', 'pet services', 'dog walking'],
  },
  'case/SC20': {
    names: ['ZwitterCo'],
    topics: ['water filtration', 'filtration membranes', 'university spinout', 'university spin out'],
  },
  'case/SC21': {
    names: ['Active Surfaces'],
    everyday: true,
    nameCues: ['solar', 'solar film', 'solar films', 'flexible solar', 'perovskite'],
    topics: ['solar films', 'solar manufacturing', 'flexible solar'],
  },
  'case/SC22': {
    names: ['Duolingo'],
    everyday: true,
    nameCues: ['luis von ahn', 'crowdsourced translation', 'translation business', 'freemium'],
    topics: ['language learning', 'language app', 'education app'],
  },
  'case/SC23': {
    names: ['Embrace'],
    everyday: true,
    nameCues: [
      'infant warmer',
      'baby warmer',
      'incubator',
      'incubators',
      'embrace innovations',
      'embrace global',
    ],
    topics: ['social enterprise', 'nonprofit and for profit', 'hybrid nonprofit', 'infant warmer'],
  },
  'case/SC24': {
    names: ['EduFi'],
    topics: ['education finance', 'education financing', 'student loans', 'school fees'],
  },
  'case/SC25': {
    names: ['r2c Semgrep', 'Semgrep', 'r2c'],
    topics: ['security tooling', 'developer tools', 'developer security', 'code scanning'],
  },
  'stage/idea': {
    terms: ['idea stage', 'ideation stage', 'idea phase', 'problem discovery stage'],
  },
  'stage/validation': {
    terms: [
      'validation stage',
      'validation phase',
      'demand validation',
      'feasibility validation',
      'validate demand',
      'validating demand',
      'validate feasibility',
    ],
  },
  'stage/MVP': {
    terms: ['mvp stage', 'mvp phase', 'initial delivery stage'],
  },
  'stage/early_traction': {
    terms: ['early traction', 'initial traction', 'traction stage', 'repeatable sales'],
    // "Get traction on TikTok" is a channel question; with first customers it is this stage.
    paired: [
      // "The repeatability of our 3D prints" is about a process; with a startup or its sales it is this stage.
      {
        terms: ['repeatability'],
        cues: [
          'startup',
          'startups',
          'stage',
          'sales',
          'selling',
          'customers',
          'revenue',
          'traction',
          'growth',
        ],
      },
      {
        terms: ['get traction', 'getting traction', 'gain traction'],
        cues: ['first customers', 'first users', 'early', 'stage', 'startup', 'mentor', 'repeatable'],
      },
    ],
  },
  'stage/growth': {
    terms: ['growth stage', 'scaling stage', 'scale up stage', 'scaleup stage'],
    paired: [
      {
        terms: ['scaling', 'scale up', 'scaleup', 'scaling up'],
        cues: [
          'mentor',
          'mentors',
          'mentorship',
          'mentoring',
          'advisor',
          'advisors',
          'stage',
          'phase',
          'challenges',
          'bottleneck',
          'bottlenecks',
        ],
      },
    ],
  },
  'stage/expansion': {
    terms: [
      'expansion stage',
      'adjacent segment',
      'adjacent market',
      'new geography',
      'international expansion',
      'expand internationally',
      'expanding internationally',
    ],
    paired: [
      {
        terms: ['expand', 'expanding', 'expansion'],
        cues: [
          'new market',
          'new city',
          'new country',
          'another city',
          'another country',
          'new region',
          'abroad',
        ],
      },
    ],
  },
};
