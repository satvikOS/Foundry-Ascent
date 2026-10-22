import type { RiskCategory } from '@foundry/contracts';

import { WORD_END, WORD_START } from './normalize.js';

/**
 * Deterministic risk rules for the pre-classifier.
 *
 * Every rule is a set of alternatives matched on normalised, lower-cased text with Unicode-aware
 * word boundaries. `exclude` patterns suppress a positive match when an exclusion match fully
 * covers it, which is how ordinary venture vocabulary ("market valuation of competitors", "price
 * discrimination", "contract manufacturer") is kept out without weakening the rule elsewhere in the
 * same message.
 *
 * Precision/recall stance (see README "Risk classifier"):
 * - safety_wellbeing crisis rules favour recall: first-person self-harm or imminent-danger language
 *   is flagged even when hedged or negated ("I'm not suicidal, but…"), because a false negative is
 *   far more costly than an unnecessary support message. Product/research context ("suicide
 *   prevention app") is excluded from the *crisis* flag but still tags safety_wellbeing.
 * - consequential categories (IP, legal, securities, medical/regulatory, conflict) favour recall
 *   on specific terms of art and exclude a curated list of everyday business uses of ambiguous words
 *   (valuation, contract, license, diagnose, threat, crisis, safe, dilute, discrimination).
 * - prompt_injection and cross_venture_request do not force an escalation (they only harden the
 *   prompt and are recorded), so they lean further towards recall.
 */
export interface RiskRule {
  /** Stable identifier `<category>:<name>` reported in `matchedRules`. */
  readonly id: string;
  readonly category: RiskCategory;
  /** Global, Unicode regexes. */
  readonly patterns: readonly RegExp[];
  /** Exclusions: a positive match fully covered by an exclusion match is ignored. */
  readonly exclude?: readonly RegExp[];
  /** Sets `crisis` (immediate human-support response, no model call). */
  readonly crisis?: boolean;
  /**
   * Matched against case-preserved text (acronyms like `SAFE`, `SEC`). Skipped when the message is
   * mostly upper-case, where case carries no signal.
   */
  readonly caseSensitive?: boolean;
  /** Also evaluated on leetspeak-folded text (prompt-injection rules). */
  readonly evasionAware?: boolean;
  /**
   * A match is ignored when the same clause says the data is *not* collected or used ("we will not
   * collect any patient information", "no patient data", "without storing PHI"). Only for data-handling
   * rules: crisis and consequential-advice rules are never negatable (a hedged "I'm not suicidal, but…"
   * still needs a human).
   */
  readonly negatable?: boolean;
  /**
   * Message-level context: the rule fires only when one of these also matches somewhere in the same message.
   * Used for lines that are ambiguous on their own ("I can't do this anymore") and are crisis language only
   * next to personal distress ("I feel so alone").
   */
  readonly requiresContext?: readonly RegExp[];
  /**
   * Message-level context: the rule does not fire when one of these matches somewhere in the same message.
   * Used for what makes a line ordinary wherever it stands: laughter ("I'm such a mess today lol, I can't deal
   * with this anymore").
   */
  readonly unlessContext?: readonly RegExp[];
  /**
   * Referent context: a match is ignored when one of these matches in the match's own sentence, the two
   * sentences before it or the one after it. Used for lines whose referent the text next to them supplies ("The
   * pilot isn't converting. I'm thinking about ending it."); work mentioned further away does not make a line
   * about the work.
   */
  readonly unlessNearby?: readonly RegExp[];
  /**
   * Message-level context that lifts `unlessNearby` and `unlessContext`: when one of these matches anywhere in the
   * message, those vetoes do not apply ("Sorry, this isn't about the startup. I'm thinking about ending it.").
   */
  readonly liftedBy?: readonly RegExp[];
}

type Alternatives = string | readonly string[];

function source(alternatives: Alternatives): string {
  return typeof alternatives === 'string' ? alternatives : alternatives.join('|');
}

/** Whole-word, case-insensitive, Unicode regex from alternatives. */
function w(alternatives: Alternatives): RegExp {
  return new RegExp(`${WORD_START}(?:${source(alternatives)})${WORD_END}`, 'giu');
}

/** Whole-word, case-sensitive regex. */
function cs(alternatives: Alternatives): RegExp {
  return new RegExp(`${WORD_START}(?:${source(alternatives)})${WORD_END}`, 'gu');
}

/** Raw (no word boundaries), case-insensitive regex. */
function raw(alternatives: Alternatives): RegExp {
  return new RegExp(`(?:${source(alternatives)})`, 'giu');
}

function rule(
  category: RiskCategory,
  name: string,
  patterns: readonly RegExp[],
  extra: Omit<RiskRule, 'id' | 'category' | 'patterns'> = {},
): RiskRule {
  return { id: `${category}:${name}`, category, patterns, ...extra };
}

// Common fragments ---------------------------------------------------------------------------------
const OWN = '(?:the |our |my |this |their )?';
const COFOUNDER = "(?:co-?founders?|cofounders?|founding team|business partners?|founding partners?)(?:'s?)?";
const EQUITY_NUM = '\\d+(?:\\.\\d+)? ?(?:%|percent)';
const PLATFORM =
  '(?:the |this |my |our )?(?:cohort|program|programme|platform|foundry|accelerator|incubator|app|system)';
/** Up to `n` intervening words inside one sentence. */
const WORDS = (n: number): string => `(?:[\\p{L}\\p{N}'-]+ ){0,${String(n)}}?`;
/** Any text up to `n` characters inside one sentence. */
const GAP = (n: number): string => `[^.?!]{0,${String(n)}}?`;
/** People and institutions that can hold rights in work product. */
const RIGHTS_HOLDER =
  '(?:university|school|college|lab|laboratory|institute|hospital|department|employer|company|startup|student|researcher|employee|intern|contractor|professor|pi|advisor|supervisor|co-?founder|cofounder)';
/** Work product whose ownership is an IP question. */
const WORK_PRODUCT =
  '(?:ip|code|codebase|software|source code|invention|inventions|technology|tech|design|designs|algorithm|algorithms|model|models|patent|patents|rights|parser|prototype|firmware|data set|dataset|sensor|device|work|results|research|method|methods|app)';

// --------------------------------------------------------------------------------------------------
// ip_licensing
// --------------------------------------------------------------------------------------------------
const IP_RULES: readonly RiskRule[] = [
  rule('ip_licensing', 'patent', [
    w([
      'patent(?:s|ed|ing|able|ability)?',
      'provisional (?:patent|application)s?',
      'pct (?:application|filing)s?',
      'uspto',
      'epo filing',
    ]),
  ]),
  rule('ip_licensing', 'ip_ownership', [
    w([
      'intellectual property',
      '(?:ip|i\\.p\\.) (?:ownership|rights?|assignment|owner|policy|policies|strategy|protection|clause|portfolio)',
      `who (?:owns|will own|would own|should own|gets) ${OWN}(?:ip|invention|technology|tech|code|algorithm|research|software|design|data set|dataset)`,
      `(?:university|school|college|lab|employer|professor|pi|advisor|supervisor) (?:owns?|claims?|has (?:a )?rights? to|could claim) ${OWN}(?:ip|invention|technology|tech|code|research|work)`,
      `(?:protect|protecting|file|filing|secure|securing|assign|assigning|transfer|transferring|own|owning|owns) ${OWN}ip`,
      'ip (?:is owned|belongs)',
    ]),
  ]),
  rule(
    'ip_licensing',
    'licensing',
    [
      w([
        'licen[cs](?:e|es|ed|ing|or|ors|ee|ees|sor|sors|sing)',
        'exclusive licen[cs]e',
        'non-?exclusive licen[cs]e',
      ]),
    ],
    {
      exclude: [
        w([
          "(?:software|saas|seat|user|subscription|enterprise|site|per[- ]seat|per[- ]user|annual|monthly|perpetual|volume|team|product|app|cloud|driver'?s|drivers) licen[cs]\\w*",
          "(?:business|liquor|food|operating|trade|import|export|contractor'?s?|professional|medical|nursing|real estate|pilot'?s?) licen[cs]\\w*",
          'licen[cs]\\w* (?:keys?|seats?|tiers?|per (?:seat|user|month|year))',
        ]),
      ],
    },
  ),
  rule('ip_licensing', 'royalty_option', [
    w(['royalt(?:y|ies)', 'option agreements?', 'field[- ]of[- ]use', 'sublicen[cs](?:e|es|ing)']),
  ]),
  rule('ip_licensing', 'invention_disclosure', [
    w([
      'invention disclosures?',
      `disclos(?:e|ed|ing|ure of) ${OWN}inventions?`,
      'inventor(?:s|ship)?',
      'invention (?:assignment|ownership|rights|agreement)',
    ]),
  ]),
  rule('ip_licensing', 'prior_art', [
    w([
      'prior art',
      'freedom[- ]to[- ]operate',
      'fto (?:search|analysis|opinion)',
      'patent (?:search|landscape)',
      'infring(?:e|es|ed|ing|ement|ements)',
    ]),
  ]),
  rule('ip_licensing', 'sponsored_research', [
    w([
      'sponsored research(?: agreements?| rights| contracts?| funding)?',
      'research (?:collaboration )?agreements?',
      'material transfer agreements?',
    ]),
  ]),
  rule('ip_licensing', 'tech_transfer', [
    w([
      'tech(?:nology)?[- ]transfer(?: office| agreements?)?',
      'ttos?',
      'tlos?',
      'otl',
      'office of technology (?:transfer|licensing|commercialization|commercialisation)',
    ]),
  ]),
  rule('ip_licensing', 'ownership_question', [
    w([
      // "Do we own it, or does the university?", "Does the lab still own the code?"
      `(?:do|does|did|would|will|could|can) (?:we|i|they|he|she|the ${RIGHTS_HOLDER}|my ${RIGHTS_HOLDER}|our ${RIGHTS_HOLDER}) (?:still |actually |really |fully |legally |even |then |automatically )?(?:own|retain|keep|hold|have (?:the )?(?:rights?|title) to)(?: ${WORDS(2)}| )(?:it|this|that|all of it|any of it|(?:the |our |my |this |that |their |all (?:the )?)${WORDS(2)}${WORK_PRODUCT})`,
      `(?:does|do|did|would|will) (?:the |our |my )?${RIGHTS_HOLDER}(?: own it| have (?:any )?(?:rights|a claim))`,
      // "the student owns it, right?", "the university would own the code"
      `(?:the |a |my |our )${RIGHTS_HOLDER} (?:still |actually |automatically |legally |fully |then |would |will |could )?owns? (?:it|this|that|(?:the |our |my |their )${WORDS(2)}${WORK_PRODUCT})`,
      `who (?:actually |really |legally )?(?:owns|will own|would own|gets) (?:it|this|that)`,
      // "own the sensor IP outright", "protect our core IP"
      `(?:own|owns|owning|owned|protect|protecting|file|filing|assign|assigning|transfer|transferring|license|licensing) (?:the |our |my |their |this |all (?:the )?)?(?:[\\p{L}-]+ ){1,2}ip`,
      'ip outright',
      'own (?:it|the ip|the code|the rights) outright',
    ]),
  ]),
  rule('ip_licensing', 'work_for_hire', [
    w([
      // Created while employed / funded: "wrote the parser while he was a paid research assistant".
      `(?:wrote|written|writes|write|writing|developed|develops|develop|built|builds|build|created|creates|create|made|invented|invents|designed|designs|coded|codes) ${WORDS(4)}(?:while|when|during|as part of|as) ${WORDS(4)}(?:research assistant|teaching assistant|ra|ta|employee|employed|grad(?:uate)? student|phd student|postdoc|intern|internship|staff member|faculty|contractor|consultant|lab job|lab position|lab work|assistantship|paid (?:job|position|role|work)|on (?:university|company|lab|work) time|working (?:at|for) (?:the |a |my |our )?(?:university|lab|company|employer|hospital|institute))`,
      'work(?:s)?[- ]for[- ]hire',
      '(?:invention|ip) assignment',
      '(?:university|lab|employer|company) (?:resources|equipment|funding|time) (?:to|for) (?:build|develop|write|create)',
    ]),
  ]),
  rule('ip_licensing', 'spin_out', [
    w([
      'spin(?:ning)?[- ]?outs?',
      'spun[- ]?out',
      `spin(?:ning)?[- ]?off (?:from|of) (?:the |a |our |my )?(?:university|lab|college|school|institute|hospital)`,
    ]),
  ]),
  rule('ip_licensing', 'multilingual', [
    w([
      'patentes?',
      'brevets?',
      'brevetto|brevetti',
      'patentanmeldung(?:en)?',
      'propiedad intelectual',
      'propriete intellectuelle',
      'propriedade intelectual',
      'proprieta intellettuale',
      'geistige[sn]? eigentum',
      "derechos de autor|droits? d'auteur|direitos autorais|diritto d'autore|urheberrecht(?:e|lich)?",
      'transferencia (?:de )?tecnologia|transfert de technologie|technologietransfer|trasferimento tecnologico',
      "(?:quien|de quien) es (?:el )?(?:codigo|software|invento|la propiedad)|a qui appartient (?:le |la |l')?(?:code|logiciel|invention|propriete)|wem geh[o]rt (?:der|die|das) (?:code|software|erfindung)",
    ]),
  ]),
  rule('ip_licensing', 'trademark_copyright', [
    w([
      'trademarks?',
      'trademarked',
      'copyright(?:s|ed)?',
      'trade secrets?',
      'open[- ]source licen[cs]es?',
      'a?gpl(?:v[23])?',
    ]),
  ]),
];

// --------------------------------------------------------------------------------------------------
// legal
// --------------------------------------------------------------------------------------------------
const LEGAL_RULES: readonly RiskRule[] = [
  rule('legal', 'contract', [w(['contracts?', 'contractual(?:ly)?'])], {
    exclude: [
      w([
        'contract (?:manufactur\\w*|research organi[sz]ations?|cro|cm|engineering firm)',
        'smart contracts?',
        '(?:market|economy|demand|margins?|budgets?|muscles?) (?:will |would |may |might |could |to |is going to )?contracts?',
      ]),
    ],
  }),
  rule('legal', 'agreement', [
    w([
      `(?:shareholders?'?|stockholders?'?|operating|partnership|founders?'?|co-?founders?'?|employment|consulting|contractor|services?|master services|vendor|supplier|distribution|reseller|joint venture|data processing|non-?compete|non-?solicitation|indemnity|settlement|separation|severance|purchase|lease|loan|advisor|advisory|teaming|pilot|data[- ]use|data[- ]sharing|collaboration|sponsorship|evaluation|beta|customer|subscription|sales|supply|manufacturing|participation|release|waiver) agreements?`,
      'msas?',
      'non-?competes?',
      'conflicts? of interest',
    ]),
  ]),
  rule('legal', 'incorporation', [
    w([
      'incorporation',
      'articles of (?:incorporation|organi[sz]ation)',
      'bylaws',
      '(?:form|forming|formed|register|registering|registered|set up|setting up|establish|establishing) (?:an? |the |our |my )?(?:llc|l\\.l\\.c\\.|c-?corp(?:oration)?|s-?corp(?:oration)?|corporation|legal entity|business entity|nonprofit|non-profit|benefit corporation|b-?corp|501\\(?c\\)?\\(?3\\)?)',
      '(?:form|forming|register|registering) (?:an? |the |our |my )?company',
      '(?:llc|c-?corp|s-?corp)s? (?:vs\\.?|or|versus) (?:an? )?(?:llc|c-?corp|s-?corp|corporation|b-?corp|nonprofit)',
      '(?:be|become|becoming|convert(?:ing)? (?:in)?to|switch(?:ing)? to|structured as|set up as|register as) an? (?:llc|c-?corp|s-?corp|corporation|delaware corporation|b-?corp|nonprofit)',
      'delaware (?:c-?corp|corporation|franchise tax|llc|flip)',
      'incorporat(?:e|ed|ing) (?:as|in|the (?:company|startup|business|venture)|our (?:company|startup|business|venture)|my (?:company|startup|business)|an? (?:llc|corporation|c-?corp|company))',
      '(?:get|getting|got|become|becoming|be|been|are|were|was|is|not yet) incorporated',
      'registered agent',
      'ein',
    ]),
  ]),
  rule('legal', 'clause', [
    w([
      '(?:un)?enforceab(?:le|ility)',
      '(?:indemnity|indemnification|non-?compete|non-?solicit(?:ation)?|exclusivity|termination|liability|arbitration|ip|data[- ]ownership|ownership|confidentiality|warranty|penalty|auto-?renewal|assignment|governing[- ]law|limitation[- ]of[- ]liability|change[- ]of[- ]control|most[- ]favou?red[- ]nation|non-?disparagement|moral rights) clauses?',
      `clauses? (?:in|of) (?:the |our |their |this |a |an )?${WORDS(2)}(?:agreement|contract|terms|lease|offer|term sheet|license|licence|mou)`,
      '(?:that|this|the) clause (?:says|states|gives|requires|lets|allows|means|is)',
      '(?:is|are) (?:that|this|the|these|those) clauses?',
    ]),
  ]),
  rule('legal', 'legality_question', [
    w([
      '(?:can|may|could|should|would) (?:we|i|they|you|a startup|a company|students?|the university|our team) (?:legally|lawfully)',
      `(?:is|are|would|will|was|isn'?t) (?:it|this|that|we|i|they) ${WORDS(1)}(?:legal|lawful|illegal|unlawful|against the law|allowed by law|permitted by law)`,
      "(?:it'?s|it is|that'?s|that is|this is|whether it'?s|whether it is|whether this is) (?:even |actually |still |not |really )?(?:legal|lawful|illegal|unlawful|against the law)",
      'legal(?:ly)? (?:allowed|permitted|required|obligated|ok|okay|fine|compliant|enforceable|binding)',
      '(?:legal|lawful) (?:to|for (?:us|me|them|a startup|students))',
      '(?:break|breaking|broke|violat(?:e|es|ed|ing)|violation of) (?:the |any |privacy |data[- ]protection |wiretap(?:ping)? |consumer[- ]protection |labou?r |employment )?(?:laws?|regulations?|statutes?)',
    ]),
  ]),
  rule('legal', 'privacy_consent', [
    w([
      // Personal data collected or used without the people's say: "pull the Wi-Fi logs ... without asking the students".
      `(?:collect|collecting|collected|track|tracking|scrape|scraping|pull|pulling|harvest|harvesting|record|recording|monitor|monitoring|log|logging|capture|capturing|sell|selling|share|sharing|use|using|access|accessing|mine|mining|store|storing|read|reading|buy|buying)${GAP(100)}${WORD_START}without (?:(?:their|the|any|explicit|prior|written|informed|user|users'?|students'?|customers'?|employees'?|patients'?|parental) )*(?:consent|permission|knowledge|authori[sz]ation|approval|notice|opt-?in|them knowing|anyone knowing|(?:asking|telling|informing|notifying|getting permission from) ${WORDS(2)}(?:them|users?|students?|customers?|employees?|people|anyone|anybody|patients?|participants?|it|parents?|staff|the university|the school|the hospital|the clinic|consent|permission))`,
      '(?:secretly|covertly|quietly|silently) (?:record|recording|track|tracking|monitor|monitoring|collect|collecting|log|logging|scrape|scraping)',
      '(?:location|biometric|facial[- ]recognition|wi-?fi|browsing|keystroke|surveillance) (?:data|logs|tracking|history) (?:of|from|about) (?:students|users|employees|customers|people|children|kids|minors)',
    ]),
  ]),
  rule(
    'legal',
    'regulatory_compliance',
    [
      w([
        `(?:without|skip|skipping|skipped|avoid|avoiding|bypass|bypassing|get around|getting around|no need for|forgo|forgoing|before getting|instead of) (?:a |an |the |any |our |their |proper |formal |official )?(?:[\\p{L}-]+ ){0,2}(?:inspections?|certifications?|certificates?|permits?|safety (?:checks?|tests?|testing|reviews?|approvals?)|code compliance|ul (?:listing|certification)|fcc (?:certification|approval|id)|building codes?|approvals? from (?:the )?(?:city|state|regulator|authorities))`,
        '(?:liability |legal |signed )?waivers?',
        '(?:sign|signing|signed|have them sign) (?:a |the )?(?:waiver|release|liability release)',
        '(?:uncertified|unlicensed|unpermitted|non-?compliant|unregulated|uninspected) (?:install(?:s|ed|ation|ations|ing)?|work|contractors?|devices?|products?|modules?|operations?|equipment|appliances?)',
        '(?:gas|fire|electrical|building|safety|health) (?:codes?|inspections?|inspectors?|regulations?)',
      ]),
    ],
    {
      exclude: [
        w([
          '(?:fee|tuition|application fee|application|course|prerequisite|clia) waivers?',
          '(?:safety|fire|building) codes? (?:of conduct)',
        ]),
      ],
    },
  ),
  rule('legal', 'multilingual', [
    w([
      // French
      "(?:est-ce|c'est|est-il|est il|serait-ce|serait-il) (?:vraiment |bien )?(?:legal|illegal|legalement|permis|autorise|interdit|conforme)",
      'legalement|illegal(?:e|es|ement)?|juridique(?:s|ment)?',
      "avocats?|contrats?|clauses? (?:du|de|d'un) contrat|proces|poursuivre en justice|poursuites judiciaires",
      'sans (?:certification|autorisation|permis|licence|consentement|homologation|agrement|inspection)',
      'rgpd',
      // Spanish
      '(?:es|seria|sera|sigue siendo) (?:legal|ilegal|licito|permitido|legalmente)',
      'legalmente|ilegal(?:es|mente)?|juridic[oa]s?|abogad[oa]s?|contratos?|clausulas?',
      'demandar(?:nos|los|le|me)?|demanda judicial|nos (?:van a )?demandar',
      'sin (?:certificacion|autorizacion|permiso|licencia|consentimiento|homologacion|inspeccion)',
      // German
      '(?:ist (?:es|das)|ware (?:es|das)|darf ich|durfen wir) (?:\\p{L}+ )?(?:legal|illegal|erlaubt|zulassig|rechtens|rechtlich)',
      'rechtlich(?:e|en|er)?|rechtsanwalt|anwalt|anwaltin|vertrag|vertrage|vertrags\\p{L}*|klage|verklagen|haftung',
      'ohne (?:zertifizierung|genehmigung|zulassung|zustimmung|einwilligung|erlaubnis|prufung|abnahme)',
      'dsgvo',
      // Portuguese
      '(?:e|seria|sera) (?:ilegal|licito|permitido por lei|legalmente permitido)',
      'advogad[oa]s?|processo judicial|acao judicial|processar (?:a|o|alguem|nos|voces?)',
      'sem (?:certificacao|autorizacao|permissao|licenca|consentimento|homologacao|inspecao)',
      'lgpd',
      // Italian
      '(?:e|sarebbe) (?:legale|illegale|lecito|consentito dalla legge)',
      'illegale|legalmente|avvocat[oi]|contratt[oi]|fare causa|causa legale|giuridic[oa]',
      'senza (?:certificazione|autorizzazione|permesso|licenza|consenso|omologazione|ispezione)',
    ]),
  ]),
  rule(
    'legal',
    'liability',
    [
      w([
        'liabilit(?:y|ies)',
        'liable',
        'indemnit(?:y|ies)',
        'indemnif(?:y|ied|ies|ication)',
        'negligen(?:ce|t)',
        'product recalls?',
        'personal(?:ly)? guarantee',
      ]),
    ],
    {
      exclude: [
        w(['assets (?:and|&) liabilities', '(?:current|long[- ]term|short[- ]term|total|other) liabilities']),
      ],
    },
  ),
  rule('legal', 'lawsuit', [
    w([
      'law ?suits?',
      'litigat(?:e|ion|ing)',
      '(?:sue|sued|suing) (?:us|them|me|him|her|you|the|our|my|their|a|an|for)',
      '(?:get|getting|got|be|being|been) sued',
      'threaten(?:ed|ing|s)? to sue',
      'cease[- ]and[- ]desist',
      'subpoena(?:s|ed)?',
      'legal action',
      'small claims',
      'court (?:case|order|date|filing|hearing)',
      'arbitration',
      'settle (?:out of court|the (?:case|lawsuit|claim|dispute))',
    ]),
  ]),
  rule('legal', 'permits_licenses', [
    w([
      "(?:business|liquor|food|operating|trade|import|export|contractor'?s?|professional|real estate) licen[cs](?:e|es|ing)",
      '(?:business|operating|zoning|building|health|food handler|vendor) permits?',
    ]),
  ]),
  rule('legal', 'nda', [w(['ndas?', 'non-?disclosure(?: agreements?)?', 'confidentiality agreements?'])]),
  rule('legal', 'terms_privacy', [
    w([
      'terms (?:of service|of use|and conditions|& conditions)',
      'privacy polic(?:y|ies)',
      'tos',
      'eulas?',
      'gdpr',
      'ccpa',
      'coppa',
      'ferpa',
      'data processing addendum',
      '(?:contract|legal|licen[cs]e|licensing|deal) terms',
      'fine print',
    ]),
  ]),
  rule(
    'legal',
    'employment_immigration',
    [
      w([
        'visas?',
        'immigration',
        'h-?1b',
        'o-?1 visa',
        'f-?1 (?:visa|student|status)',
        'stem opt',
        'opt (?:extension|status)',
        'work (?:permit|authori[sz]ation)',
        'green card',
        'wrongful (?:termination|dismissal)',
        'employment law',
        'misclassif(?:y|ied|ication)',
        'worker classification',
        '1099 (?:vs\\.?|or|versus) w-?2',
        '(?:fire|firing|fired|lay off|laying off|terminate|terminating) (?:an? |my |our |the )?(?:employee|employees|staff member|intern|interns)',
      ]),
    ],
    {
      exclude: [
        w([
          'visa (?:and|or|&) (?:mastercard|amex|american express|discover)',
          '(?:mastercard|amex),? (?:and |or )?visa',
          'visa (?:cards?|payments?|network|debit|credit|checkout)',
        ]),
      ],
    },
  ),
  rule(
    'legal',
    'advice',
    [
      w([
        'legal(?:ly)? (?:advice|counsel|question|questions|issue|issues|risk|risks|review|opinion|obligations?|requirements?|structure|exposure|implications?|binding|problems?|trouble)',
        'lawyers?',
        'attorneys?',
        'law firm',
        'legal clinic',
        'is (?:it|this|that) (?:legal|illegal|lawful|allowed by law)',
        'illegal(?:ly)?',
        'unlawful(?:ly)?',
        'tax (?:advice|implications?|liability|filing|election|obligations?)',
      ]),
    ],
    {
      // Patent and trademark professionals are an IP matter (escalated as ip_licensing, not legal).
      exclude: [
        w(
          '(?:patent|ip|intellectual property|trademark|copyright) (?:attorneys?|lawyers?|counsel|law firms?|agents?)',
        ),
      ],
    },
  ),
];

// --------------------------------------------------------------------------------------------------
// securities_investment
// --------------------------------------------------------------------------------------------------
const SECURITIES_RULES: readonly RiskRule[] = [
  rule(
    'securities_investment',
    'valuation',
    [
      w([
        'valuations?',
        'pre-?money',
        'post-?money',
        `(?:value|valuing|valued) ${OWN}(?:company|startup|venture|business) at`,
        'how much is (?:the |our |my )?(?:company|startup|venture|business) worth',
      ]),
    ],
    {
      exclude: [
        w([
          "(?:market|competitors?'?|competitor's|their|its|industry|public|public[- ]company|comparable|peer|category|sector|incumbents?'?|asset|property|real estate|inventory) valuations?",
          'valuations? (?:of|for) (?:competitors|comparables|comps|public companies|the market|the industry|other companies|similar companies|incumbents|the sector|peers|the category|our competitors|their (?:company|companies))',
          'valuation (?:multiples?|comps)',
        ]),
      ],
    },
  ),
  rule('securities_investment', 'safe', [cs(['SAFEs?', 'Safe notes?'])], { caseSensitive: true }),
  rule('securities_investment', 'safe_context', [
    w([
      'safe (?:notes?|agreements?|rounds?|instruments?|investments?|investors?|terms|caps?|financing|documents?|docs)',
      '(?:post-?money|pre-?money|uncapped|capped|mfn|yc|y combinator) safes?',
      '(?:raise|raising|raised|issue|issuing|issued|sign|signing|signed|convert|converting) (?:on |via |through |with )?(?:an? |the |our |two |three |\\d+ )?safes',
      '(?:raise|raising|raised|issue|issuing|issued) (?:on |via |through |with )?an? safe',
    ]),
  ]),
  rule('securities_investment', 'convertible', [
    w([
      'convertible(?: notes?| debt| securit(?:y|ies)| instruments?| loans?)?',
      'conversion (?:discount|cap)',
      'valuation cap',
    ]),
  ]),
  rule(
    'securities_investment',
    'cap_table_equity',
    [
      w([
        'cap(?:italization)? ?tables?',
        'captables?',
        'dilut(?:e|ed|es|ing|ion|ive)',
        'option pools?',
        'vesting(?: schedules?)?',
        'vested',
        'equity (?:split|splits|stakes?|grants?|allocation|compensation|percentage|ownership|offers?|incentives?|plans?|deal|for (?:investors?|advisors?|co-?founders?))',
        '(?:split|splitting|divide|dividing|allocate|allocating) (?:the )?equity',
        '(?:stock|share) options?',
        'incentive stock options?',
        'esops?',
        'rsus?',
        '83 ?\\( ?b ?\\)(?: election)?',
        'sweat equity',
        'how much equity',
        `(?:give|giving|gave|offer|offering|grant|granting|trade|trading) (?:up |away )?(?:${EQUITY_NUM}|equity|shares|stock)`,
        `${EQUITY_NUM} (?:of (?:the |our |my )?(?:company|startup|equity|business|shares)|equity|stake)`,
        `in exchange for (?:equity|shares|stock|${EQUITY_NUM})`,
        'shares? (?:of|in) (?:the |our |my )?(?:company|startup)',
      ]),
    ],
    {
      exclude: [
        w([
          'dilut(?:e|ed|es|ing|ion) (?:the |our |my )?(?:message|messaging|brand|focus|value proposition|positioning|attention|solution|solutions|sample|samples|reagents?|concentration|antibody|compound)',
          'dilut\\w* (?:with|in) (?:water|saline|buffer|media|medium)',
          '(?:serial|sample|buffer) dilution',
          'vested interests?',
          `(?:give|giving|gave|offer|offering|grant|granting) (?:up )?${EQUITY_NUM} (?:discount|off|rebate|commission|cashback|refund|more|less)`,
        ]),
      ],
    },
  ),
  rule('securities_investment', 'term_sheet', [
    w([
      'term ?sheets?',
      'liquidation preferences?',
      'pro[- ]rata rights?',
      'anti-?dilution',
      'board seats?',
      'participating preferred',
      'preferred (?:stock|shares|equity)',
      'drag-?along',
      'tag-?along',
      'protective provisions',
    ]),
  ]),
  rule('securities_investment', 'securities_law', [
    w([
      'securities',
      'reg(?:ulation)? (?:d|cf|a\\+?)',
      'form d',
      'rule 50[46](?: ?\\(?[bc]\\)?)?',
      'equity crowdfunding',
      'blue sky laws?',
      'token (?:sale|offering|generation event)',
      'icos?',
      'initial coin offerings?',
      'initial public offering',
      'ipos?',
      'broker-?dealers?',
    ]),
  ]),
  rule('securities_investment', 'sec_acronym', [cs(['SEC(?: filings?| rules?| registration| exemption)?'])], {
    caseSensitive: true,
  }),
  rule('securities_investment', 'accredited', [
    w([
      '(?:non-?)?accredited investors?',
      'accredited (?:status|investor)',
      'sophisticated investors?',
      'qualified purchasers?',
    ]),
  ]),
  rule('securities_investment', 'investment_advice', [
    w([
      'investment advice',
      'financial advice',
      'should i (?:invest|buy|sell) (?:in )?(?:stocks?|shares|crypto|bitcoin|the stock|options|bonds)',
      '(?:invest|investing|put|putting|use|using) (?:all )?(?:of )?(?:my |our )?(?:savings|retirement(?: savings| account)?|401 ?\\(?k\\)?|life savings|student loans?|personal money|own money|house|home equity) (?:in|into|on|to fund)',
    ]),
  ]),
];

// --------------------------------------------------------------------------------------------------
// medical_regulatory
// --------------------------------------------------------------------------------------------------
/** Clinical settings a coach must not prescribe ("alert threshold", "dose", "alarm level"). */
const CLINICAL_PARAMETER =
  'thresholds?|doses?|dosages?|dosing|(?:alarm|alert|warning|trigger) (?:thresholds?|levels?|limits?|settings?)|cut-?offs?|safe (?:levels?|limits?|ranges?)|(?:insulin|medication|drug) (?:doses?|levels?|amounts?)';
const MEDICAL_RULES: readonly RiskRule[] = [
  rule('medical_regulatory', 'fda_pathway', [
    w([
      'fda',
      'food and drug administration',
      '510 ?\\( ?k ?\\)s?',
      '510ks?',
      'pre-?market (?:approval|notification|submission)',
      'pma',
      'de ?novo (?:pathway|request|classification|submission)',
      'investigational (?:device exemption|new drug)',
      'ide (?:application|study|submission)',
      'ind (?:application|submission|filing|enabling)',
      'class (?:i|ii|iii|1|2|3) (?:medical )?devices?',
      'medical devices?',
      'samd',
      'software as a medical device',
      'ce[- ]mark(?:ing|ed)?',
      'eu mdr',
      'ivdr',
      'notified body',
      'iso ?13485',
      'iso ?14971',
      'iec ?62304',
      'mhra',
      'clia(?: waiver| waived| certified| lab)?',
      'ivds?',
      'in vitro diagnostics?',
      'regulatory (?:approval|clearance|pathway|submission|strategy for (?:the |our )?(?:device|drug|diagnostic))',
    ]),
  ]),
  rule('medical_regulatory', 'clinical_human_subjects', [
    w([
      'clinical (?:trials?|study|studies|validation|evidence|data|pilots?|research|investigations?|endpoints?|outcomes?|claims?|decision support|utility)',
      'phase (?:i|ii|iii|iv|1|2|3|4)(?:/(?:ii|iii|2|3))? (?:trials?|study|studies)',
      'irbs?',
      'institutional review boards?',
      'ethics (?:committee|board|approval|review)',
      'human (?:subjects?|participants?)',
      'informed consent',
      'good clinical practice',
      'randomi[sz]ed controlled trials?',
      'rcts?',
    ]),
  ]),
  rule('medical_regulatory', 'clinical_parameters', [
    w([
      // "how to set the alert threshold for patients with neuropathy", "what dose is safe for diabetics"
      `(?:set|setting|configure|configuring|calibrate|calibrating|adjust|adjusting|choose|choosing|pick|picking|determine|recommend|tune|tuning|what|which|how (?:high|low|much|often))${GAP(50)}${WORD_START}(?:${CLINICAL_PARAMETER})${WORD_END}${GAP(60)}${WORD_START}(?:patients?|diabetics?|people with|persons? with|someone with|users with|individuals with|clinical use|residents with|children with|adults with)`,
      `(?:for|in) (?:a |the |my |our )?(?:diabetic |elderly |pediatric |paediatric )?patients? (?:with|who (?:have|has))${GAP(60)}${WORD_START}(?:what|which|how) ${GAP(40)}${WORD_START}(?:${CLINICAL_PARAMETER})${WORD_END}`,
    ]),
  ]),
  rule('medical_regulatory', 'multilingual', [
    w([
      'dispositivos? medicos?|dispositifs? medicaux|dispositif medical|medizinprodukte?|dispositivi medici',
      'ensayos? clinicos?|essais? cliniques?|klinische (?:studie|studien|prufung)|ensaios? clinicos?|sperimentazion[ei] clinic[ah]e?',
      'datos (?:de|del|de los) pacientes?|donnees (?:des|de|du) patients?|patientendaten|dados (?:de|do|dos) pacientes?|dati (?:dei|del) pazient[ie]',
      'diagnostico medico|diagnostic medical|medizinische diagnose|diagnosi medica',
    ]),
  ]),
  rule(
    'medical_regulatory',
    'health_data',
    [
      w([
        'hipaa(?:[- ]compliant| compliance)?',
        'phi',
        'protected health information',
        'patient (?:data|records?|information|privacy|health (?:data|information|records?)|identifiable|consent|samples?)',
        '(?:electronic )?(?:health|medical) records?',
        'ehrs?',
        'emrs?',
        'health data',
        'medical data',
        'clinical data',
        'baa',
        'business associate agreements?',
      ]),
    ],
    { negatable: true },
  ),
  rule('medical_regulatory', 'diagnosis', [
    w([
      "(?:medical|clinical|differential|patient'?s?|cancer|disease|early|automated|ai|self)[- ]diagnos(?:is|es|e|ing|tics?)",
      "diagnos(?:is|es|e|ed|ing) (?:of |for )?(?:patients?|diseases?|cancer|conditions?|illness(?:es)?|symptoms?|disorders?|infections?|diabetes|sepsis|alzheimer'?s|dementia|depression|adhd|autism|tumou?rs?|fractures?|stroke|heart disease|covid(?:-19)?|skin lesions?|melanoma)",
      'diagnostic (?:devices?|tests?|accuracy|imaging|assays?|kits?|algorithms?|software|labs?|claims?|test kits?|sensitivity|specificity)',
      'diagnose (?:me|my (?:symptoms?|condition|rash|pain|illness|child|kid|son|daughter))',
      'do i have (?:cancer|diabetes|covid|adhd|depression|an? (?:infection|disease|disorder|condition))',
    ]),
  ]),
  rule('medical_regulatory', 'medical_claims', [
    w([
      'medical (?:advice|claims?|treatment|conditions?|regulatory|regulations?|grade|compliance|liability)',
      '(?:health|therapeutic|treatment|efficacy|wellness|clinical) claims?',
      "(?:treats?|cures?|prevents?|treating|curing|preventing|heals?|healing) (?:cancer|diseases?|diabetes|depression|anxiety|covid(?:-19)?|alzheimer'?s|dementia|heart disease|infections?|insomnia|adhd|autism|obesity|hypertension|arthritis)",
      'drug (?:approval|development|trials?|interactions?|safety)',
      'prescriptions?',
      'prescrib(?:e|es|ing|ed) (?:medications?|drugs?|medicines?|treatments?|antibiotics|opioids|doses)',
      'dosages?',
      'dosing',
      'biocompatib(?:le|ility)',
      'reimbursement codes?',
      'cpt codes?',
      'medicare',
      'medicaid',
    ]),
  ]),
];

// --------------------------------------------------------------------------------------------------
// safety_wellbeing (crisis rules first)
// --------------------------------------------------------------------------------------------------
const PRODUCT_CONTEXT_SUICIDE = w([
  'suicid\\w* (?:prevention|awareness|research|risk (?:screening|assessment|models?|detection|prediction|factors?)|hotlines?|helplines?|crisis lines?|lifeline|screening|detection|data|rates?|statistics|stats|ideation (?:screening|detection|research|data|scales?))',
  '(?:prevent|preventing|prevention of|reduce|reducing|detect|detecting|detection of|screen(?:ing)? for|predict(?:ing)?|research(?:ing)? on|study(?:ing)?|flag(?:ging)?) (?:youth |teen |student |veteran )?suicid\\w*',
]);

// Indirect ideation --------------------------------------------------------------------------------
//
// People in crisis rarely say "suicide". The phrase families below follow published screening and warning-sign
// guidance: the C-SSRS screener (wishing to be dead, to go to sleep and not wake up), the AFSP warning signs (no
// reason to live, being a burden, feeling trapped, unbearable pain, saying goodbye) and QPR's indirect verbal
// clues ("my family would be better off without me", "I just want out", "I won't be around much longer").
//
// Most of these lines are also ordinary talk: "I just want out" about a flat, "I'm done with it all!" after the
// thesis, "I'll end it here" at the end of a call, "This is my last message" when the credits run out, "Should I
// end it?" about a pilot. No list of referents is ever complete, so a line is crisis on its own only when its
// wording is (INDIRECT_IDEATION: "nobody would care if I died", "I'm thinking about ending it with pills"), and
// the ambiguous lines are decided like this:
//  1. contemplating "ending it", "what's the point of any of this", "I just want it all to stop"
//     (AMBIGUOUS_IDEATION): crisis unless work (WORK_REFERENT) stands in the line's sentence, the two before it or
//     the one after it ("The pilot isn't converting. I'm thinking about ending it.");
//  2. every other ambiguous line (DISTRESS_LINES: wanting out, not being around, being done with it all, a
//     sign-off, a goodbye, "I can't do this anymore") is crisis only next to personal distress (PERSONAL_DISTRESS,
//     a feeling about the speaker), and only when neither work nor everyday life (EVERYDAY_REFERENT) stands next
//     to it and no one laughs: distress about the deck is still about the deck;
//  3. a personal cue anywhere in the message (VETO_LIFTERS) lifts the vetoes of 1 and 2: the speaker says the
//     work is not the referent ("this isn't about the startup"), asks for someone to talk to or for secrecy, or
//     names a personal setback ("I failed my exams", "my startup failed", "my wife left me");
//  4. "I can't do this anymore" as the whole message (BARE_OVERWHELM) is a wellbeing signal: a forced escalation
//     while the coach still answers, never the crisis path.
// A required cue is read outside the rule's own matches (a line is never its own context), and a veto is read on
// the plain text, never the leetspeak-folded one (see classifier.ts). A phrase quoted as material the founder works
// with (PRODUCT_QUOTE: "our chatbot must handle 'I want the pain to stop'") is not the speaker's. Context is read
// in English; multilingual lines are the unambiguous kind.

/** First person singular subject, including spellings without apostrophes ("im", "ive") and "imma". */
const I_SUBJECT = "(?:i|i'?m|i am|i'?ve|i have|i'?ll|i will|i'?d|imma|ima)";
/** Up to `n` words that do not open a new subject, so "I told her we're ending it" is not first person. */
const OWN_WORDS = (n: number): string =>
  `(?:(?!(?:we|we'?re|they|they'?re|he|she|he'?s|she'?s|you|you'?re|u|y'?all|everyone|everybody|someone|people)${WORD_END})[\\p{L}'-]+ ){0,${String(n)}}?`;
/** Subject dropped at the start of a sentence: "thinkin bout endin it", "been thinking about walking into traffic". */
const THINKING_ABOUT =
  '(?:^|(?<=[.!?;,] ))(?:been |keep |always |just |sometimes )?(?:thinking|thinkin|thought|considering) (?:about|bout|abt|of)';
/**
 * The speaker turning something over: "I'm thinking", "I've been thinking", "I keep thinking", "I seriously
 * considered". Never a negation ("I never thought about ending it") and never somebody else ("people hate to think
 * about dying").
 */
const CONTEMPLATING = `${I_SUBJECT} (?:(?:just|really|honestly|seriously|kind of|kinda|sort of|actually|still|also|sometimes|often|always|constantly|keep|kept|been|started|start)\\s)*(?:thinking|thinkin|thought|think|considering|considered|contemplating)`;
/** The sentence ends here. */
const SENTENCE_END = '(?=\\s*(?:$|[.!?]))';
/** The thought ends here: "done with life." but not "done with life admin". */
const THOUGHT_END = `(?=\\s*(?:$|[.!?;:,)"]|-|(?:and|but|so|honestly|tbh|lol|already|completely|forever|anymore|any more|i)${WORD_END}))`;
/** How often: "I think about dying every day". */
const HOW_OFTEN =
  '(?: (?:every (?:day|night|morning|single day)|a lot|all the time|constantly|lately|again|sometimes|often|daily|recently|more and more|at night))*';
/**
 * What may follow "ending it" when "it" has no object: the end of the thought, a time, or a new clause. Not "here",
 * "there", "now" or "today": "I'll end it here" is how a call ends.
 */
const AFTER_ENDING_IT = `(?=\\s*(?:$|[.!?;:,)"]|-|(?:all|for good|once and for all|tonight|tomorrow|soon|already|someday|one day|this (?:week|weekend|time|year)|every (?:day|night|single day)|all the time|a lot|lately|again|last (?:night|week|time|year)|yesterday|before|once|twice|for real|honestly|tbh|lol|though|seriously|and|but|because|cause|cuz|coz|so|i|im|i'm|if|or|when)${WORD_END}))`;
/** "ending it and pivoting to B2B": ending a project to start the next thing. */
const NOT_MOVING_ON = `(?! *,? *(?:and|then|so (?:i|we) can|to) (?:start\\p{L}*|mov(?:e|ing) on|pivot\\p{L}*|switch\\p{L}*|get(?:ting)? (?:a|another) (?:job|role)|go(?:ing)? back to|focus\\p{L}*|apply\\p{L}*|join\\p{L}*|look(?:ing)? for (?:a|another)|find(?:ing)? (?:a|another)|tak(?:e|ing) (?:a|the) (?:job|role|offer)))`;
/** Means of self-harm that can follow "ending it with …", including someone else's ("my dad's gun"). */
const MEANS =
  "(?:a |the |my |some |all (?:my |the |of my )?|these |those )?(?:\\p{L}+'s )?(?:pills|meds|medication|medications|tablets|painkillers|sleeping pills|rope|gun|knife|blade|razor|razors|belt|overdose)";
/** Drugs an overdose is named by. */
const DRUGS =
  '(?:pills|meds|medication|medications|tablets|sleeping pills|painkillers|tylenol|paracetamol|xanax|ambien|antidepressants|insulin)';
/** An overdose that has already happened: "I took a bunch of pills an hour ago". */
const OVERDOSE_END = `(?: (?:(?:an? (?:hour|few hours|couple of hours|minute|few minutes|while)|half an hour|\\d+ (?:hours?|minutes?|mins?)) ago|earlier(?: today)?|last night|this morning|just now))?${THOUGHT_END}`;
/**
 * People who might be "better off" without the speaker. Not "my team" or "we": "my team would be fine if I was
 * gone" is about a role.
 */
const OTHERS =
  "(?:everyone|everybody|they|they'?d|people|my (?:family|friends|parents|kids|children|partner|wife|husband|mom|mum|dad)|the world|you|you'?d|y'?all|you all|you guys|all of (?:you|them)|the family|them)";
/** Family: "my kids would be better off without me" is never about a role, whatever follows. */
const FAMILY =
  '(?:my|our) (?:family|kids|children|son|daughter|wife|husband|parents|mom|mum|dad|mother|father|loved ones|girlfriend|boyfriend|fiancee?|friends)|the family';
/** After "if I was gone": a bounded absence ("gone for two weeks") is not a wish to stop existing. */
const NOT_TEMPORARY_ABSENCE = `(?! (?:from|off|for|to|into|until|till|while|during|over|after|before|on|at) (?!(?:good|ever|forever|this world|the world|the earth|the face of the earth|existence|everyone|everybody|my life|life|the void|nothing|nothingness|thin air|the abyss|the dark|the darkness)${WORD_END}))`;
/** The speaker no longer being here: "if I wasn't here", "if I died", "if I disappeared". */
const ABSENCE = `(?:(?:was|were|'?d|had) (?:dead|(?:been )?gone${NOT_TEMPORARY_ABSENCE}|never born|never been born|no longer (?:here|around|alive))|(?:wasn'?t|weren'?t|wasnt|werent|was not|were not) (?:(?:here|around|in the picture)(?! (?:for|at|in|on|during|when|while|today|tonight|this|next|to)(?![\\p{L}\\p{N}_]))|alive|born)|(?:just )?(?:died|killed myself|ended it|was never born|were never born|didn'?t exist|did not exist|didnt exist|didn'?t wake up|never woke up)|(?:just )?(?:disappeared|vanished)${NOT_TEMPORARY_ABSENCE})`;
/**
 * "better off without me on the sales calls / as CEO / micromanaging every PR / running the company": a role, not
 * the speaker's existence. Only a role is excluded: a time ("for a while", "during the holidays", "until the end
 * of time", "while I'm like this") or anything else ("running around ruining things", "managing to screw
 * everything up", "at this point", "as their dad") keeps the burden line, which main has always caught.
 */
const NOT_A_ROLE = `(?! (?:on (?!(?:this|the) (?:earth|planet|world)${WORD_END})(?:the|this|that|these|those|our|their|his|her|my|a|an|board|calls?|sales|deals?|payroll)|in (?:the |this |that |our |their |these )?(?:meetings?|room|loop|calls?|office|lead|charge|kitchen|codebase|repo|discussions?|negotiations?|process|deal|role|seat|position|weeds|middle of (?:this|it|the deal))|as (?:the |their |your |our |his |her |my |a |an |its )?(?:ceo|cto|coo|cfo|cpo|founder|co-?founder|cofounder|lead|leader|manager|pm|head|boss|chair|president|director|vp|engineer|designer|developer|salesperson|spokesperson|face|point person|decision[- ]maker|bottleneck|middleman|gatekeeper)|at (?:the |this |that |our |their )?(?:meetings?|table|helm|wheel|desk|office|event|demo|conference|offsite|board|standup|pitch|front)|(?:running|leading|managing|handling|owning) (?:the|this|that|our|their|its|it|things|sales|ops|operations|marketing|engineering|product|support|hiring|fundraising)|micromanag\\p{L}*|meddling|interfering|hovering|pitching|selling|coding|reviewing|approving|steering|calling the shots|weighing in|butting in|second-guessing|bottlenecking)${WORD_END})`;
/**
 * "wake up late", "wake up at 6", "wake up for work": ordinary sleep talk. Only these: "wake up to another day",
 * "wake up at all", "wake up with this feeling", "wake up for anything" are the wish main has always caught.
 */
const NOT_ORDINARY_WAKING = `(?! (?:late|early|in time|on time|too (?:late|early)|tired|sick|groggy|hungover|at (?:\\d|dawn|noon|sunrise|four|five|six|seven|eight|nine|ten)|before (?:\\d|dawn|noon|sunrise|work|class|school|my alarm|the alarm)|for (?:work|class|school|my (?:shift|flight|class|lecture)|an? early|\\d)|(?:until|till|til) (?:\\d|noon|lunch|monday|tuesday|wednesday|thursday|friday|saturday|sunday|the weekend|the afternoon)|to (?:an? |the |my )?(?:alarms?|emails?|notifications?|texts?|messages?)|with (?:a )?(?:hangover|headache|migraine))${WORD_END})`;
/**
 * "I don't want to be here when the investors arrive / for the 7am standup": a place and a time. Only these:
 * "at all", "on this earth", "anymore", "tonight" and anything else keep the line main has always caught.
 */
const NOT_SOMEWHERE_TO_BE = `(?! (?:(?:when|whenever) (?:the|my|our|their|they|he|she|you|we|everyone|people)|for (?!the rest${WORD_END})(?:the|this|that|our|their|\\d)|at (?:the (?!end${WORD_END})|\\d)|by (?:the|\\d)|this (?:morning|afternoon|evening)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in (?:the|this|our) (?:office|meeting|room|building|lab|class|lecture))${WORD_END})`;
/**
 * "disappear from social media", "disappear into the lab", "disappear for a week to focus": leaving a platform, or
 * going away to work. Only these: any other absence, bounded or not ("for a while", "off the planet", "from my
 * family's lives"), keeps the wish main has always caught.
 */
const NOT_LEAVING_TO_WORK = `(?! (?:(?:completely|entirely|for a (?:bit|while|week|day|month|few days)|for (?:a|one|two|three|\\d+) (?:days?|weeks?|months?)) )?(?:from|off) (?:the |my |all |every )?(?:social media|socials|social|the internet|internet|online|linkedin|twitter|x|instagram|insta|tiktok|facebook|snapchat|reddit|discord|slack|whatsapp|group ?chats?|email|emails|inbox|news|feeds?|notifications)${WORD_END}| into (?:the |my )?(?:lab|library|office|studio|garage|cave|code|codebase|work|zone|flow)${WORD_END}|[^.!?\\n]{0,80}? (?:to|and) (?:just )?(?:focus|work on|build|ship|study|write|code|concentrate|read|travel|get (?:stuff|things|work) done|catch up on)${WORD_END})`;
/** After a place one can jump from or a vehicle: the end of the thought or a place, not "the building committee". */
const AFTER_PLACE = `(?=\\s*(?:$|[.!?;:,)"]|-|(?:and|but|so|or|i|tonight|today|tomorrow|soon|someday|one day|right now|now|honestly|tbh|lol|of|at|near|in|on|downtown|again)${WORD_END}))`;
/** What may follow a feeling: the end of the thought, or more about the speaker's own life ("alone in this"). */
const FEELING_END = `(?: (?:inside|right now|lately|these days|again|all the time|every day|most days|today|tonight|for (?:weeks|months|days|years|a while|so long|a long time)|in (?:this|my (?:life|head)|life|general)|about (?:myself|my life|everything|it all|who i am)|with (?:myself|my life|everything|it all)))*${THOUGHT_END}`;

/**
 * Personal distress anywhere in the message: the context that makes an ambiguous line crisis language. Each cue
 * is a feeling about the speaker that ends the thought, never a business state: "I'm drowning." but not "I'm
 * drowning in emails", "Nobody cares." but not "nobody cares about our product", "I've lost everything." but not
 * "I've lost everything in the database migration". Not "burnt out" or "a mess": founders say both about a week
 * of work (burnout is a wellbeing signal of its own, the `distress` rule).
 */
const PERSONAL_DISTRESS = w([
  `(?:i'?m|im|i am|i(?: (?:just|really|honestly|kind of|kinda|still|also|now|always|constantly|sometimes|often|literally))* (?:feel|felt|keep feeling)|i'?ve been|ive been|i have been|feeling|i'?m feeling)(?: (?:so|really|very|completely|totally|just|honestly|utterly|pretty|kind of|kinda|feeling|been|always|constantly|all|literally|seriously|absolutely|deeply|increasingly|incredibly|like|such|still|getting))* (?:hopeless|worthless|useless|empty|numb|miserable|alone|lonely|trapped|broken|ashamed|humiliated|unloved|unwanted|invisible|a failure|a burden|a disappointment|falling apart|breaking down|drowning|depressed|dead inside|in (?:so much |constant )?pain|at (?:my |a )?breaking point|at the end of my (?:rope|tether)|at rock bottom|in a (?:really |very )?(?:dark|bad) place)${FEELING_END}`,
  // "can't cope" is also an overwhelm line; the classifier never reads a line as its own context.
  `(?:can'?t|cannot|cant) (?:stop crying|get out of bed|feel anything|breathe|cope)(?: (?:anymore|any more|with (?:anything|life|any of (?:this|it)|it all|everything)))?${THOUGHT_END}`,
  "(?:i'?ve been|i keep|i was|i'?m|been|keep) crying",
  'crying (?:every|all) (?:day|night)',
  `(?:no ?one|nobody|no-one)(?: else)?(?: even| really| actually)? (?:cares|would care|would notice|would even notice|would miss me|loves me|needs me|wants me|understands(?: me)?|gets it|gets me|listens(?: to me)?|cares about me|is there for me)(?: (?:anymore|any more|at all|around here|anyway|anyways))?${THOUGHT_END}`,
  `i (?:hate|can'?t stand) (?:myself|my life|who i am|everything about me|(?:being alive|living|existing)${THOUGHT_END})`,
  `(?:my (?:parents|family|mom|mum|dad|mother|father|friends|wife|husband|kids|boyfriend|girlfriend)|everyone|everybody) (?:all )?(?:hates?|despises?) me${THOUGHT_END}`,
  `everything (?:hurts|is falling apart|feels (?:hopeless|pointless|empty|dark|heavy|meaningless)|is pointless|is hopeless|is meaningless|is (?:just )?too much)${FEELING_END}`,
  "(?:it'?s|its|it is|everything is|this is all) all (?:just )?too much|(?:it'?s|its|it is|this is) (?:all )?(?:just )?too much for me",
  `(?:the pain is (?:unbearable|too much|killing me)|unbearable pain|(?:emotional|mental) pain|it hurts so much|hurts too much)${THOUGHT_END}`,
  `i (?:just )?(?:give up|gave up) on (?:everything|life|myself|living|people)${THOUGHT_END}`,
  `(?:i'?ve|ive|i have|i) (?:just )?lost everything${THOUGHT_END}`,
  "(?:i'?ve|ive|i have|i) let (?:everyone|everybody|my family|my parents|them all|you all|everyone i love) down",
  `i (?:always )?(?:ruin|ruined|destroy|destroyed|screw up|screwed up|mess up|messed up) everything${THOUGHT_END}`,
  "what'?s wrong with me",
  "(?:i'?m scared of|i don'?t trust) myself",
  `dark thoughts(?: (?:again|lately|are back|keep coming(?: back)?))?${THOUGHT_END}`,
  `(?:i'?ve|ive|i have|i'?m|im|i am|i) (?:just |finally |really )?(?:hit|reached|at|hitting) (?:a |my |an all-time |a new )?(?:new )?rock bottom${FEELING_END}`,
  'my (?:life|mental health) (?:is )?(?:at )?rock bottom',
  'my mental health (?:is )?(?:bad|awful|terrible|horrible|in pieces|falling apart|tanking|shot)',
  `nothing (?:matters|makes sense|helps|feels real)(?: (?:to me|anymore|any more))*${THOUGHT_END}`,
  `tired of (?:everything|it all|life|living|being alive|existing|fighting|trying|pretending)(?: (?:anymore|any more|so hard))?${THOUGHT_END}`,
  `(?:i have|i'?ve got|there'?s|there is) no hope(?: left)?${THOUGHT_END}`,
]);

/**
 * Venture work next to an ambiguous line: its referent ("The pilot isn't converting. I'm thinking about ending
 * it."). Nouns only where a word is also a verb ("deal with" is not a deal), and not "partner", which is also a
 * person. Study and chores ("exams", "homework", "emails") are not things a founder ends: they are referents of
 * the distress lines only (EVERYDAY_REFERENT), so "I failed my exams. I'm thinking about ending it." is crisis.
 */
const WORK_REFERENT = w([
  'start-?ups?|compan(?:y|ies)|ventures?|business(?:es)?|products?|features?|pilots?|betas?|launch(?:es|ed|ing)?|releases?|deploy(?:s|ed|ing|ment|ments)?|ship(?:ping)?',
  'customers?|clients?|users?|vendors?|suppliers?|partnerships?|business partners?|contracts?|(?:the|a|this|that|our|their) deal|deals|leases?|agenc(?:y|ies)|portal',
  'investors?|vcs?|angels?|pitch(?:es|ing)?|decks?|slides?|spreadsheets?|cap table|(?:seed|funding|pre-seed|series [a-d]|investment|bridge|angel|the|our) round|fundrais\\p{L}*|funding|grants?|investor update',
  'revenue|mrr|arr|pricing|prices?|sales|marketing|campaigns?|ads|budget|runway|invoices?|payroll|numbers|metrics|kpis?|okrs?|churn|funnel|conversion|sign-?ups?|waitlist|go-to-market|gtm|inventory|orders|shipments?|manufacturing|factory|warehouse',
  'apps?|website|landing page|code|codebase|bugs?|ci|(?:the|our|a) builds?|servers?|api|database|dashboard|repo|github|prs?|sprints?|roadmap|projects?|prototypes?|mvp|pivot(?:s|ed|ing)?|b2b|b2c|saas|subscriptions?|trials?|experiments?|onboarding',
  'stripe|payments?|billing|aws|shopify|hubspot|salesforce|figma|airtable|zapier|quickbooks|xero',
  'engineers?|developers?|designers?|employees?|contractors?|freelancers?|interns?|interviews?|surveys?|co-?founders?|cofounders?|hire|hiring|meetings?|demos?|demo day|standups?|stand-ups?|cohort|accelerator|incubator|competition|market|competitors?|stakeholders?|loi|proposals?|office|data|slack|notion|jira|linkedin|newsletter|quarter|internship|program(?:me)?s?',
  // The conversation itself: "this call", "our session".
  "(?:this|the|our|that|today'?s|a|great|good|nice|long|quick|voice|video|zoom) (?:call|chat|session|conversation|convo|thread)",
  // Leaving: "I'm moving to Berlin. I won't be around much longer."
  'moving (?:to|out|back|abroad|away|house|cities)|relocat\\p{L}*|graduat\\p{L}*|semester|flights?|trip|vacation|holidays?|sabbatical|parental leave',
]);

/** Everyday life next to a distress line: "I feel so alone. I can't take it anymore, my roommate's dog barks all night." */
const EVERYDAY_REFERENT = w([
  'class(?:es)?|lectures?|exams?|finals|midterms?|assignments?|homework|essays?|thesis|dissertation|tax(?:es)?|paperwork|admin|emails?|inbox|forms|chores|laundry|dishes',
  'roommates?|flatmates?|housemates?|neighbou?rs?|landlord|dogs?|cats?|puppy|kitten|commute|traffic|noise|weather|heat|humidity|construction|wi-?fi|internet|printer|laptop|phone|keyboard|trains?|bus|subway|airline|delays?|hangover|allergies',
]);

/** Laughter: "lol I can't deal with this anymore" is banter. */
const LAUGHTER = [
  w(['lol+', 'lmao+', 'lmfao', 'rofl', 'ha(?:ha)+h?', 'he(?:he)+', 'jk', 'just kidding']),
  raw('😂|🤣|😅|😆|💀'),
];

/** Venture nouns a speaker can say a line is not about: "this isn't about the startup". */
const WORK_NOUNS =
  'work|job|start-?up|company|venture|business|product|app|pitch|deck|program(?:me)?|cohort|accelerator|pilot|customers?|investors?|co-?founders?|cofounders?|team|code|project|fundraising|launch';

/** A setback clause that ends there: "my startup failed." but not "my first startup failed in 2019". */
const SETBACK_END = `(?=\\s*(?:$|[.!?;,]|(?:and|but|so|i|today|yesterday|last (?:night|week))${WORD_END}))`;

/**
 * Personal cues that lift every referent veto of an ambiguous line, read anywhere in the message: the work is said
 * not to be the referent, the speaker asks for someone to talk to or for secrecy, or names a personal setback. A
 * venture that has already failed ("my startup failed.") cannot be what "it" refers to.
 */
const VETO_LIFTERS = w([
  `(?:not|isn'?t|isnt|is not|wasn'?t|wasnt|was not|nothing)(?: really| even| actually| just| only| at all)? (?:about|related to|to do with|because of) (?:the |my |our |this |that |any )?(?:${WORK_NOUNS})`,
  `(?:someone|somebody|anyone|anybody|a person|a therapist|a counsel+or|a professional|a doctor|a human) (?:i can |to )?talk to(?! about (?!(?:it|this|how i feel|my feelings|what i'?m going through|everything|me)${WORD_END}))`,
  `(?:talk|speak) to (?:someone|somebody|a therapist|a counsel+or|a professional|a doctor)(?! about (?!(?:it|this|how i feel|my feelings|what i'?m going through|everything|me)${WORD_END}))`,
  `i (?:really |just |desperately )?need (?:some )?help${SENTENCE_END}`,
  `please help me${SENTENCE_END}`,
  "(?:don'?t|do not|dont|never) tell (?:anyone|anybody|no ?one|them|him|her|people|(?:my|the|your) \\p{L}+)",
  'keep (?:this|it) (?:between us|to yourself|a secret|secret|quiet)',
  "promise (?:me )?(?:you )?(?:won'?t|will not|wont|not to) tell",
  '(?:nobody|no one|no-one) (?:can|should|must) know',
  'i (?:just |totally |completely )?(?:failed|flunked) (?:my |all my |all of my |both my |the |this |another )?(?:exams?|finals|midterms?|class(?:es)?|courses?|modules?|semester|year|degree|thesis|defen[cs]e|boards|bar)',
  '(?:wife|husband|girlfriend|boyfriend|fiancee?|partner|spouse|gf|bf) (?:just )?(?:left me|walked out|moved out|broke up with me|dumped me|is leaving me|cheated on me|wants a divorce|asked for a divorce)',
  // Without "me", only a partner who is never a business partner: "my girlfriend left, I'm thinking about ending it".
  `my (?:wife|husband|girlfriend|boyfriend|fiancee?|spouse|gf|bf) (?:just )?(?:left|walked out|moved out)${SETBACK_END}`,
  `(?:my|our|the) (?:startup|start-up|company|business|venture) (?:just |finally )?(?:failed|died|collapsed|went under|went bust|folded|is dead)${SETBACK_END}`,
  'broke up with me|dumped me|getting (?:a )?divorced?',
  'lost my (?:mom|mum|mother|dad|father|brother|sister|son|daughter|child|baby|best friend|husband|wife|grandma|grandmother|grandpa|grandfather|home|house|apartment|job|scholarship|visa)',
  "(?:got|been|was|am|i'?m) (?:just )?(?:evicted|kicked out of (?:my|the) (?:house|apartment|home|program|school))",
]);

/** A quoted phrase: straight quotes after normalisation; a closing single quote is one no letter follows ("I'd"). */
const QUOTED = `(?:'(?=\\S)[^\\n]{1,200}?'(?![\\p{L}\\p{N}])|"[^"\\n]{1,200}")`;
/**
 * A phrase quoted as material the founder works with, not as their own words: "our chatbot needs to handle 'I
 * want the pain to stop'", "a model that spots phrases like 'nobody would care if I died'", "customer quote for the
 * deck: '…'". A founder quoting their own thoughts ("I keep thinking 'nobody would care if I died'") is not
 * excluded, and neither are the rules main has always had.
 */
const PRODUCT_QUOTE = w(
  `(?:(?:phrases?|messages?|statements?|sentences?|texts?|inputs?|prompts?|examples?|quotes?|copy|taglines?|testimonials?)(?: such as| like)?|(?:handle|handles|handling|detect|detects|detecting|spot|spots|spotting|flag|flags|flagging|catch|catches|catching|recogni[sz]e|recogni[sz]es|classify|classifies|moderate|moderates|respond to|responds to)(?: \\p{L}+){0,2}?|quote for (?:the|our|a) \\p{L}+)[:,]? ${QUOTED}`,
);

/** Indirect phrasings that are crisis language whatever the context. */
const INDIRECT_IDEATION = [
  // Burden (AFSP, QPR). "Better off without me" itself is the `suicide` rule's, as on main.
  `${OTHERS}(?: would| will)?(?: all| honestly| really| just| probably| genuinely| so much| a lot)*(?: be)? (?:better off|happier|better|fine|okay|ok|relieved)(?: without me)? if i ${ABSENCE}`,
  `(?:the world|everyone|everybody|my family)(?: would| will|'?d)?(?: honestly| really| just| probably| genuinely)?(?: be)? (?:a )?(?:better|happier)(?: place)? without me(?: in it| around| here| alive)?${THOUGHT_END}`,
  // Subject-free only for death: "the company would be better off if I was gone" is about a role.
  "better off if i (?:was|were|'?d been|had been) (?:dead|never born)",
  `(?:nobody|no one|no-one|noone)(?: else)?(?: would| will|'d|'ll)?(?: even| really| actually| ever)? (?:care|notice|miss me|mind|cry|be sad)(?: at all)? if i ${ABSENCE}`,
  // Wishing to be dead or not to wake up (C-SSRS item 1).
  "wish (?:that )?i(?: had|'?d| was| were) never (?:been )?born",
  "wish (?:that )?i (?:wasn'?t|weren'?t|wasnt|werent|was not|were not) alive",
  'wish i could (?:just )?(?:die(?! (?:of|from|laughing)\\b)|be dead|stop existing|cease to exist|not exist)',
  `(?:wish|want|hope|wanna|like)(?: i could| to| i would| i'?d)?(?: just)? (?:go to sleep|fall asleep|sleep|close my eyes|lie down) and (?:never|not|don'?t|wouldn'?t|won'?t|dont|wont)(?: ever)? wake up${NOT_ORDINARY_WAKING}`,
  `(?:hope|hoping|wish|pray|praying)(?: that)? i(?: just| really| simply)? (?:don'?t|do not|won'?t|will not|never|dont|wont|wouldn'?t|wouldnt|didn'?t)(?: ever)? wake up${NOT_ORDINARY_WAKING}`,
  // "I wouldn't mind if I died", never "I don't care if I die doing it" (hyperbole about the work).
  "(?:wouldn'?t|would not|wouldnt)(?: really| even)? (?:mind|care)(?: if)?(?: i)? (?:dying|died|die|being dead|not waking up|never waking up|didn'?t wake up|did not wake up|didnt wake up|never woke up|don'?t wake up|got hit by a (?:car|bus|truck|train))(?! (?:trying|on (?:this|that) hill|my|the|our|it|of|from|laughing|to|doing)\\b)",
  "(?:don'?t|do not|dont)(?: really| even)? (?:mind|care)(?: if)?(?: i)? (?:not waking up|never waking up|didn'?t wake up|did not wake up|didnt wake up|never woke up|don'?t wake up)",
  // The speaker's own thoughts of dying, never other people's ("our users don't like to think about dying").
  `(?:${CONTEMPLATING} (?:about|of)|${THINKING_ABOUT}) (?:not waking up|never waking up|not being (?:here|around|alive)|being dead|dying|killing myself|ending my life|not existing|disappearing forever)${HOW_OFTEN}${THOUGHT_END}`,
  // "Dark thoughts" is how many people say suicidal thoughts.
  `(?:(?:i'?ve been|ive been|i have been|i'?m|im|i am|i keep|been|keep) having|i(?: still| also| sometimes| often)? (?:have|get|had|keep getting)) (?:some |a lot of |lots of |these |those |the |really |more )?dark thoughts(?: (?:again|lately|recently|at night|every (?:day|night)|all the time))?${THOUGHT_END}`,
  // No reason to live (AFSP).
  '(?:nothing|nobody|no one|no-one|not much)(?: left| else)? to live for',
  `(?:i have|i'?ve got|i got|there'?s|there is) no (?:will|desire|reason|wish) to (?:live|keep living|go on|be alive)${THOUGHT_END}`,
  `(?:life|my life|living|this life|being alive|existing)(?: just| really| honestly| simply)? (?:isn'?t|is not|isnt|ain'?t|aint|is no longer|feels|seems)(?: really| even)? (?:worth (?:living|it)|pointless|meaningless|unbearable)${THOUGHT_END}`,
  "(?:isn'?t|isnt|ain'?t|is no longer|no longer) worth living",
  `${I_SUBJECT} (?:so |just |really |completely |totally |honestly |officially )*done with (?:life|living|being alive|existing|this life|my life|this world)${THOUGHT_END}`,
  `i (?:just |really |honestly |so )*(?:want|wanna|need) out of (?:this life|life|this world)${THOUGHT_END}`,
  `(?:${I_SUBJECT} (?:just |really |honestly )*)?(?:want to|wanna|wish i could) (?:just )?(?:disappear|vanish) (?:forever|for good|from (?:this world|the world|existence|the face of the earth)|and never come back|and not come back)`,
  // Wanting it all to stop: unbearable pain (AFSP). The speaker's own pain: "customers want the pain to stop" is a
  // value proposition.
  `${I_SUBJECT} (?:just |really |only |honestly |so |desperately )*(?:want|wanna|need|wish)(?: for)? (?:the pain|my life|this life|life|the hurt|the hurting|this pain|the suffering) to (?:stop|end|be over|go away|just stop|just end|finally (?:stop|end))(?! (?:by|before|after|so (?:i|we) can|in time|on time)${WORD_END})`,
  // Imminence: "I'm ending it tonight" is never about a pilot.
  `(?:${I_SUBJECT} ${OWN_WORDS(5)}|${THINKING_ABOUT} )(?:end|ending|endin) (?:it|things|everything)(?: all)? (?:tonight|tonite|2nite)${THOUGHT_END}`,
  // Means.
  `(?:${I_SUBJECT} ${OWN_WORDS(5)}|${THINKING_ABOUT} )(?:end|ending|endin) (?:it|things|everything|my life)(?: all)? (?:with|using|by (?:taking|using|overdosing on)) ${MEANS}`,
  `(?:${I_SUBJECT} ${OWN_WORDS(4)}|${THINKING_ABOUT} )(?:jump|jumping|throw myself|throwing myself|step|stepping) (?:off|from) (?:a |the |that |this |my |some )?(?:bridge|building|roof|rooftop|balcony|cliff|ledge|tower|overpass|window)${AFTER_PLACE}`,
  `(?:${I_SUBJECT} ${OWN_WORDS(4)}|${THINKING_ABOUT} )(?:walk|walking|step|stepping|jump|jumping|throw myself|throwing myself|lie down|lying down) (?:into|in front of|onto) (?:traffic|oncoming traffic|a train|the train|a bus|the bus|a truck|a car|the tracks|the highway)${AFTER_PLACE}`,
  `(?:${CONTEMPLATING} (?:about|of)|${THINKING_ABOUT}|${I_SUBJECT} ${OWN_WORDS(4)}) (?:walk|walking|swim|swimming|wade|wading)(?: out)? into the (?:sea|ocean|lake|river|water|waves) and (?:not|never) (?:come|coming) back`,
  // An overdose, not a medication routine: "take all my meds before the flight" is adherence.
  `(?:${I_SUBJECT} ${OWN_WORDS(4)}|${THINKING_ABOUT} )(?:just )?(?:take|taking|took|swallow|swallowing|swallowed|down|downing|downed|overdose on|od on) (?:every one|every last one|a (?:whole )?bottle|the (?:whole )?bottle|a handful|handfuls|a bunch|the rest) (?:of )?(?:my |the |these |those |them )?${DRUGS}(?: (?:at once|all at once|tonight|together|in one go|right now|now))?${OVERDOSE_END}`,
  `(?:${I_SUBJECT} ${OWN_WORDS(4)}(?:just )?(?:take|taking|took)|${THINKING_ABOUT} taking|(?:^|(?<=[.!?;,] ))(?:just |already )?took) all (?:of )?(?:my |the |these |those |them )?${DRUGS} (?:at once|all at once|tonight|together|in one go|right now)${OVERDOSE_END}`,
  `${I_SUBJECT} ${OWN_WORDS(4)}(?:just )?(?:swallow|swallowing|swallowed|down|downing|downed|overdose on|od on) (?:all|every one|a (?:whole )?bottle|a handful|the rest) (?:of )?(?:my |the |these |those )?${DRUGS}`,
  'swallowed (?:all|a (?:whole )?bottle|a handful) (?:of )?(?:my |the )?(?:pills|meds|tablets|painkillers)',
  // Slang, algospeak, misspellings ("kms", "unalive", "sewerslide", "suicidial"); leetspeak is folded first. "kms"
  // only as the speaker's own intention: "we're moving our keys to KMS" is AWS.
  `(?:${I_SUBJECT} (?:(?:just|literally|actually|really|honestly|seriously|might|could|should|will|wanna|gonna|finna|tryna|want to|going to|about to|bout to|ready to|need to)\\s)*|(?:gonna|wanna|finna|tryna|bout to) |${CONTEMPLATING} (?:about|of|bout|abt) |${THINKING_ABOUT} )kms(?=\\s*(?:$|[.!?,;:]|(?:rn|tonight|today|now|lol|fr|tbh|i|and|but|honestly)${WORD_END}))`,
  'unaliv(?:e|ing|ed) (?:my ?self|me)',
  `(?:want|wanna|going|gonna|plan|planning|thinking about|thinking of|ready) (?:to )?unaliv(?:e|ing)${THOUGHT_END}`,
  "(?:to|gonna|wanna|'ll|will|might|should|just|about to|finna) (?:off|top|neck|end|delete) myself(?! (?:up|off|out|from|in|on|onto|into|as|with|for)\\b)",
  'kill(?:ing)? my ?self',
  'sewer[- ]?slid(?:e|ing)',
  // "Users can self-delete their accounts" is a product feature: only a first-person intention counts.
  `(?:want to|wanna|gonna|going to|thinking (?:about|of)|might|could|should|'ll|will|ready to|about to|plan to|planning to) self[- ]?delet(?:e|ing)${THOUGHT_END}`,
  'suicidi(?:al|e)|suicidle|sucid(?:e|al)|suicd(?:e|al)|suisid(?:e|al)|suiside|suicde|sucide',
  // Spanish, French, German, Portuguese, Italian, Russian (accent-folded).
  'estar(?:ia|ian|iamos) (?:todos )?mejor sin mi|(?:todos|todo el mundo) (?:estaria|estarian|vivirian) mejor sin mi',
  '(?:quiero|quisiera|voy a|pienso en|pensando en|tengo ganas de|me gustaria) acabar con todo(?! (?:el|la|los|las|lo)\\b)',
  'dormir(?:me)? y no (?:volver a )?despertar(?:me)?(?! hasta\\b)|ojala (?:estuviera muert[oa]|me muriera|no despertara)',
  'mieux sans moi(?! (?:comme|au|a la|dans|sur|pour)\\b)',
  '(?:pense|penser|songe|songer|veux|vais|voudrais|aimerais) (?:a |serieusement a |souvent a )?en finir',
  "(?:m'endormir|dormir) et ne (?:jamais |plus )?(?:jamais )?me reveiller",
  'besser (?:dran )?ohne mich(?! (?:als|im|in|bei|auf)\\b)',
  'einschlafen und nicht (?:mehr )?aufwachen|(?:allem|dem ganzen|dem allen) ein ende (?:setzen|machen|bereiten)',
  'melhor sem mim|(?:quero|vou|penso em|pensando em) acabar com tudo(?! (?:o|a|os|as|isso)\\b)|dormir e (?:nunca mais|nao) acordar',
  'meglio senza (?:di )?me|dormire e non svegliarmi(?: piu)?',
  'лучше без меня|хочу исчезнуть(?! (?:из|на|до|с)(?![\\p{L}]))|заснуть и не проснуться|покончить со всем',
];

/** Scripts without spaces between words (and Devanagari): no word boundaries. */
const INDIRECT_IDEATION_RAW = [
  '没有我[^。！？\\n]{0,6}更好|想结束(?:这一切|一切|生命|自己)|活着没(?:有)?(?:意思|意义)|不想再活',
  'いなくなりたい|生きる意味(?:が|は)?(?:ない|無い)|私がいない方が',
  'मेरे बिना सब (?:बेहतर|खुश)|सब खत्म कर (?:देना|दूँ|दूं)',
];

/**
 * Contemplating "ending it", or wanting to: "I'm thinking about ending it", "I've been thinking about ending
 * things", "I just want to end it", "I almost ended it". Never a question or a plan for the session ("Should I end
 * it?", "If I end it, do I owe the library anything?", "I'll end it here").
 */
const ENDING_IT = `(?:(?:${CONTEMPLATING}(?: (?:about|of|bout|abt))?|${THINKING_ABOUT}) (?:end|ending|endin)|${I_SUBJECT} (?:just |really |honestly |seriously )*(?:want to|wanna|need to) (?:just )?end|${I_SUBJECT} (?:(?:almost|nearly) ended|came close to ending)) (?:it|things|everything)${NOT_MOVING_ON}${AFTER_ENDING_IT}`;

/** Lines that are crisis unless work stands next to them (rule 1 of the decision rule above). */
const AMBIGUOUS_IDEATION = [
  ENDING_IT,
  // Wanting it all to stop, where "it all" may be the work.
  `(?:want|wanna|need|wish)(?: for)? (?:it all|everything|all of (?:this|it)) to (?:stop|end|be over|go away|just stop|just end|finally (?:stop|end))(?! (?:by|before|after|so (?:i|we) can|in time|on time)${WORD_END})`,
  // Loss of meaning (AFSP). Spoken transcripts are not contracted: "what is even the point".
  `what(?:'?s| is) (?:even )?the (?:even )?point (?:of (?:any of (?:this|it)|it all|everything|even trying|trying|getting up|carrying on|my life|me|waking up)(?: (?:anymore|any more))?|(?:anymore|any more))(?=\\s*(?:$|[.!?;:,]|(?:if|when|anyway|honestly|tbh|really|i|seriously)${WORD_END}))`,
  `is there (?:even |really )?(?:a|any) point (?:anymore|any more|to (?:anything|any of (?:this|it)|living|life|going on))${THOUGHT_END}`,
  "(?:i'?ve|i have|i|ive)(?: just| completely| totally| kind of| kinda)? lost (?:the|my|all|any) will to live",
];

/**
 * Lines that are crisis only next to personal distress (rule 2): the QPR clues ("I just want out", "I won't be
 * around much longer", "pretty soon you won't have to worry about me"), being done with it all, any first-person
 * "ending it", a sign-off, a goodbye, "I can't do this anymore", wanting to disappear or for it to stop.
 */
const DISTRESS_LINES = [
  ...AMBIGUOUS_IDEATION,
  `${I_SUBJECT} ${OWN_WORDS(5)}(?:end|ending|endin|(?:almost|nearly) ended) (?:it|things|everything)${NOT_MOVING_ON}${AFTER_ENDING_IT}`,
  `${I_SUBJECT} ${OWN_WORDS(5)}(?:end|ending|endin) (?:it|things) (?:here|there|(?:right )?now|today|for (?:now|today)|early|at that|on that note)(?: (?:(?:right )?now|today|for (?:now|today)))?${NOT_MOVING_ON}(?! (?:with|on|for|by|before|after|to)${WORD_END})`,
  'i (?:just |really |honestly |so )*(?:want|wanna|need) out',
  `${I_SUBJECT} (?:probably |just |really )?(?:won'?t|wont|will not|(?:am|'m|m) not (?:going to|gonna)) be (?:around|here) (?:(?:for )?(?:much|very) long(?:er)?|for long|after (?:tonight|today|this week)|(?:by|for) (?:tomorrow|next week))`,
  `(?:you|u|everyone|everybody|nobody|no one|they|people|y'?all|you all)(?: guys)? (?:won'?t|wont|will not|will never|won'?t ever) (?:have to|need to|ever have to|ever need to) (?:worry|deal|bother) (?:about|with) me(?: (?:much longer|for (?:much )?long|anymore|any more|soon|again|after (?:tonight|today)))?${SENTENCE_END}`,
  `${I_SUBJECT} (?:so |just |really |completely |totally |honestly )*done with (?:everything|it all|all of (?:it|this)|everyone)${SENTENCE_END}`,
  `(?:this is|it'?s|consider this|so this is) (?:my )?(?:final |last )?goodbye(?=\\s*(?:$|[.!?]|(?:everyone|everybody|all|forever|for good|for real)${WORD_END}))`,
  'goodbye forever',
  `this (?:is|will be) my (?:last|final) (?:message|post|words?)${SENTENCE_END}`,
  "(?:can'?t|cant|cannot|can not) (?:do|take|handle|bear|stand|deal with|cope with|face|keep doing|go through) (?:this|it|that|any of (?:this|it)|this life|life|everything|any more of this) (?:anymore|any more|any longer|much longer)",
  "(?:can'?t|cant|cannot|can not) (?:keep going|go on|keep living|carry on|keep fighting)(?: like this)?(?: (?:anymore|any more|any longer))?",
  "i (?:just |really |honestly )*(?:can'?t|cant|cannot) (?:anymore|any more)",
  '(?:want|wanna|wish i could) (?:to )?(?:just )?(?:disappear|vanish)',
  '(?:want|wanna|need) (?:it|this) to (?:stop|end|be over)',
];

/** Fillers a bare line may open with: "Honestly, I can't handle this anymore." */
const BARE_OPENER =
  '(?:(?:ugh+|honestly|seriously|man|god|omg|ok|okay|yeah|so|and|but|just|tbh|idk|i mean|i feel like|i think|i swear)[,.!…]* )*';
/**
 * "I can't do this anymore" as the whole message (rule 4): nothing in it says what "this" is. With anything else
 * in the message ("…, the bank froze my account again", "Why is LaTeX like this", "…raining so the sensors dry
 * out") the line has a referent, named or not, and is not flagged.
 */
const BARE_OVERWHELM = [
  `^\\s*${BARE_OPENER}(?:i )?(?:just |really |honestly |simply |literally |seriously )*(?:can'?t|cant|cannot|can not) (?:(?:do|take|handle|bear|stand|deal with|cope with|face|keep doing|go through) (?:this|it|that|any of (?:this|it)|this life|life|everything) (?:anymore|any more|any longer)|(?:keep going|keep living|carry on|keep fighting)(?: like this)?(?: (?:anymore|any more|any longer))?|(?:anymore|any more))[\\s.!?…]*$`,
  `^\\s*${BARE_OPENER}i (?:just |really |honestly |only )*(?:want|wanna|need) (?:it|this) to (?:stop|end|be over)(?: already)?[\\s.!?…]*$`,
];

const SAFETY_RULES: readonly RiskRule[] = [
  rule(
    'safety_wellbeing',
    'suicide',
    [
      w([
        'suicid(?:e|al|ality)',
        'kill(?:ing)? myself',
        'end(?:ing)? (?:my (?:own )?life|it all)',
        '(?:take|taking|took) my (?:own )?life',
        "i(?:'m| am)? (?:just |really |honestly )?(?:want to|wanted to|wanna|going to|gonna|plan to|planning to|ready to) die",
        'wish (?:i was|i were|i was never|to be) (?:dead|born)',
        "(?:don'?t|do not|dont) (?:really )?(?:want to|wanna) (?:live|be alive|exist)(?: anymore| any more| any longer)?",
        // Main's lines, narrowed only by the ordinary continuations named in NOT_SOMEWHERE_TO_BE and
        // NOT_ORDINARY_WAKING ("I don't want to be here when the investors arrive", "… wake up early"): anything
        // else after them ("at all", "on this earth", "to another day") is still crisis.
        `(?:don'?t|do not|dont) (?:really )?(?:want to|wanna) be here(?: anymore| any more| any longer)?${NOT_SOMEWHERE_TO_BE}`,
        // "be around" is new, and ends the thought: "I don't want to be around my cofounder anymore" is about a person.
        `(?:don'?t|do not|dont) (?:really )?(?:want to|wanna) be around(?: anymore| any more| any longer)?${THOUGHT_END}`,
        `(?:don'?t|do not|dont) (?:really )?(?:want to|wanna) wake up(?: anymore| any more| ever again)?${NOT_ORDINARY_WAKING}`,
        'no (?:reason|point) (?:to|in) (?:live|living|going on)',
        'better off dead',
        // Burden (AFSP, QPR): only a role after it makes it about the work ("on the sales calls", "as CEO").
        `better off without me${NOT_A_ROLE}`,
        `(?:${FAMILY})(?: would| will|'?d)?(?: all| honestly| really| just| probably| genuinely| so much| a lot)*(?: be)? better off without me`,
        'not worth living',
        "i (?:can'?t|cannot) go on(?: (?:anymore|any more|any longer|living))?(?=\\s*(?:[.!?,;]|$))",
      ]),
    ],
    {
      crisis: true,
      // Leetspeak is folded too ("su1c1de", "k1ll mys3lf"): a person in crisis does not owe us a spelling.
      evasionAware: true,
      exclude: [
        PRODUCT_CONTEXT_SUICIDE,
        w(
          "i(?:'m| am)? (?:just |really |honestly )?(?:going to|gonna) die (?:of|from) (?:embarrassment|laughter|boredom|shame|excitement|curiosity|cringe|the cringe|happiness)",
        ),
      ],
    },
  ),
  rule(
    'safety_wellbeing',
    'passive_ideation',
    [
      w([
        // Hopelessness and loss of meaning are core suicide-risk signals: route to a person, no model call.
        "(?:don'?t|do not|can'?t|cannot|no longer|never) (?:really |even |honestly )?see (?:the |any )?(?:point|reason|purpose|meaning) (?:of|in|to) (?:anything|everything|living|life|going on|it all|being alive|being here|existing|trying|carrying on|getting up|any of it)",
        "(?:don'?t|do not|can'?t|cannot) see (?:the |any )?(?:point|reason) (?:anymore|any more)",
        "what(?:'?s| is) the (?:point|use) (?:of|in) (?:living|life|anything|going on|it all|being alive|trying anymore|being here|me)",
        "(?:there'?s|there is) no (?:point|reason) (?:in |to )?(?:anything|living|going on|being alive|trying anymore|being here)",
        'nothing (?:matters|is worth it|means anything) (?:anymore|any more)',
        // Not leaving a platform or going away to work ("disappear from social media for a week to focus"); any
        // other absence, bounded or not ("for a while"), is crisis as on main.
        `(?:i|i'?ve) (?:just |really |sometimes |honestly )*(?:want|wanted|wish i could|wish i could just) (?:to )?(?:just )?(?:(?:disappear|vanish)${NOT_LEAVING_TO_WORK}|stop existing|not exist|not wake up|sleep forever|fall asleep and (?:never|not) wake up)`,
        "(?:i'?m|i am) (?:so |just |really )?tired of (?:living|being alive|life|existing)",
        "(?:i feel|i'?m feeling|it feels|feels) (?:like )?(?:there'?s |there is )?no way out",
        "(?:i|i'?m|i am|i'?ve|i want to|i just want to|i'?m ready to|i am ready to) (?:just |finally |going to |gonna )?give up on (?:life|living|everything|myself)",
        "(?:i'?m|i am|i feel like|i feel like i'?m) (?:just |such )?a burden (?:to|on) (?:everyone|everybody|my family|my team|others|people|them)",
        // First-person hopelessness that is not about a specific business problem ("hopeless about our CAC").
        "(?:i'?m|i am|i'?ve been|i have been|i(?: (?:just|really|honestly|kind of|kinda|still|also|now|always|constantly))* (?:feel|felt|keep feeling)|feeling)(?: (?:so|really|very|extremely|completely|totally|utterly|pretty|kind of|kinda|just|honestly|deeply|increasingly|feeling|constantly|always))* (?:hopeless|worthless|empty inside)(?! (?:about|that|with|on|regarding|when it comes to|at|for|to))",
      ]),
    ],
    { crisis: true },
  ),
  rule('safety_wellbeing', 'indirect_ideation', [w(INDIRECT_IDEATION), raw(INDIRECT_IDEATION_RAW)], {
    crisis: true,
    evasionAware: true,
    exclude: [PRODUCT_QUOTE],
  }),
  rule('safety_wellbeing', 'ambiguous_ideation', [w(AMBIGUOUS_IDEATION)], {
    crisis: true,
    evasionAware: true,
    exclude: [PRODUCT_QUOTE],
    unlessNearby: [WORK_REFERENT],
    liftedBy: [VETO_LIFTERS],
  }),
  // Distress about the deck is still about the deck: a work or everyday referent next to the line, or laughter,
  // keeps it out of the crisis path (the `distress` rule still flags the distress itself).
  rule('safety_wellbeing', 'despair_in_context', [w(DISTRESS_LINES)], {
    crisis: true,
    evasionAware: true,
    exclude: [PRODUCT_QUOTE],
    requiresContext: [PERSONAL_DISTRESS],
    unlessNearby: [WORK_REFERENT, EVERYDAY_REFERENT],
    unlessContext: LAUGHTER,
    liftedBy: [VETO_LIFTERS],
  }),
  // "I can't do this anymore" as the whole message: a wellbeing signal (a person is asked to check in), not the
  // crisis path.
  rule('safety_wellbeing', 'overwhelm', [w(BARE_OVERWHELM)]),
  rule(
    'safety_wellbeing',
    'crisis_multilingual',
    [
      w([
        // Spanish
        // Leaving a platform or going away to work is not ideation ("desaparecer de las redes sociales"); any other
        // absence, bounded or not ("por un tiempo", "pra sempre"), is crisis as on main, in every language.
        `(?:quiero|quisiera|me quiero|voy a) (?:morir(?:me)?|matarme|suicidarme|desaparecer(?! (?:de (?:las |mis )?redes|de (?:instagram|internet|linkedin|twitter|tiktok)|para (?:concentrarme|enfocarme|trabajar|estudiar))${WORD_END})|quitarme la vida)`,
        'suicid(?:io|arme|arse|a)|quitarme la vida|acabar con mi vida|hacerme dano',
        'no quiero (?:seguir )?(?:vivir|viviendo|estar aqui|despertar)',
        'no (?:le )?veo (?:el )?sentido a (?:nada|la vida|vivir|seguir)',
        '(?:me siento|estoy) (?:muy |tan |completamente )?(?:sin esperanza|desesperanzad[oa])',
        // French
        `(?:je veux|j'ai envie de|je vais) (?:mourir|me tuer|me suicider|disparaitre(?! (?:des reseaux|de (?:linkedin|instagram|twitter|internet|facebook|tiktok)|d'internet|pour (?:me concentrer|travailler|bosser|etudier))${WORD_END})|en finir)`,
        "suicid(?:e|er|aire)|envie d'en finir|en finir avec (?:la vie|tout)|mettre fin a (?:mes jours|ma vie)|me faire du mal",
        'je ne veux plus vivre',
        "je ne vois plus (?:l'interet|le sens|aucun sens|de sens) (?:de|a) (?:rien|la vie|vivre|continuer)",
        '(?:je me sens|je suis) (?:tellement |si |completement |vraiment )?(?:desesperee?|sans espoir)',
        // German
        '(?:ich will|ich mochte) (?:sterben|nicht mehr leben|mich umbringen)',
        'selbstmord|suizid|mich umbringen|mir das leben nehmen|mich selbst verletzen',
        'keinen sinn mehr',
        '(?:ich fuhle mich|ich bin) (?:so |total |vollig |einfach )?hoffnungslos',
        // Portuguese
        `(?:quero|vou) (?:morrer|me matar|sumir(?! (?:das redes|do (?:instagram|linkedin|twitter)|da internet|(?:pra|para) (?:me concentrar|focar|trabalhar|estudar))${WORD_END}))`,
        'suicid(?:io|ar)|me matar|tirar (?:a )?minha (?:propria )?vida|acabar com (?:a )?minha vida',
        'nao quero (?:mais )?viver',
        'nao vejo sentido em (?:nada|viver|continuar)',
        '(?:me sinto|estou) (?:tao |muito |completamente )?(?:sem esperanca|desesperad[oa])',
        // Italian
        `(?:voglio|vorrei) (?:morire|uccidermi|suicidarmi|sparire(?! (?:dai social|da (?:instagram|internet|linkedin)|per (?:concentrarmi|lavorare|studiare))${WORD_END}))`,
        'suicid(?:io|armi|arsi)|uccidermi|togliermi la vita|farla finita',
        'non voglio (?:piu )?vivere',
        'non vedo (?:piu )?(?:il )?senso (?:di|in|nel) (?:niente|nulla|vivere|andare avanti)',
        '(?:mi sento|sono) (?:cosi |completamente )?(?:senza speranza|disperat[oa])',
        // Russian, Arabic
        'хочу умереть|покончить с собой|суицид|самоубийств\\p{L}*|не хочу жить|нет смысла жить',
        'انتحار|أريد أن أموت|اريد ان اموت|أقتل نفسي|اقتل نفسي',
      ]),
      // Scripts without spaces between words (and Devanagari): no word boundaries.
      raw([
        '想死|自杀|自殺|不想活|活不下去|轻生|輕生',
        '死にたい|消えたい|生きていたくない',
        'आत्महत्या|मरना चाहत[ाी]|जीना नहीं चाहत[ाी]|खुद को मार',
      ]),
    ],
    { crisis: true, exclude: [PRODUCT_CONTEXT_SUICIDE] },
  ),
  rule(
    'safety_wellbeing',
    'self_harm',
    [
      w([
        'self[- ]?harm(?:ing)?',
        'self[- ]?injur(?:y|ies|ing)',
        '(?:hurt|hurting|harm|harming|cut|cutting|starve|starving) myself',
        'overdos(?:e|ed|ing)',
      ]),
    ],
    {
      crisis: true,
      exclude: [
        w([
          'self[- ]?(?:harm|injur)\\w* (?:prevention|detection|research|screening|data|content|moderation|monitoring|risk)',
          '(?:prevent|preventing|detect|detecting|reduce|reducing|screen(?:ing)? for|moderat(?:e|ing)|flag(?:ging)?) self[- ]?(?:harm|injur)\\w*',
          'overdos\\w* (?:prevention|detection|reversal|response|data|deaths|rates|risk)',
          '(?:prevent|preventing|detect|detecting|reverse|reversing|opioid|fentanyl) overdos\\w*',
        ]),
      ],
    },
  ),
  rule(
    'safety_wellbeing',
    'imminent_danger',
    [
      w([
        "(?:i'?m|i am|i feel|i'?m feeling) (?:in (?:immediate |serious |real )?danger(?! of)|not safe|unsafe|scared for my (?:life|safety))",
        "(?:we'?re|we are) in (?:immediate |serious |real )?danger(?! of)",
        '(?:someone|somebody|he|she|they|my (?:co-?founder|cofounder|partner|boss|landlord|ex|husband|wife|boyfriend|girlfriend|roommate|advisor|investor|manager)) (?:is going to|will|wants to|threatened to|is trying to|tried to|is threatening to) (?:kill|hurt|attack|shoot|stab|harm|beat|assault) (?:me|us|my)',
        '(?:he|she|they|someone|somebody) (?:has|had|brought|is carrying) a (?:gun|knife|weapon)',
        "(?:i was|i am|i'?m|i'?ve been|i got|i keep getting|i'?m being|i am being|we were|we are being) (?:physically |sexually )?(?:abused|assaulted|attacked|beaten|raped)",
        'domestic (?:violence|abuse)',
      ]),
    ],
    { crisis: true },
  ),
  rule('safety_wellbeing', 'self_harm_topic', [
    w(['suicid(?:e|al|ality)', 'self[- ]?harm(?:ing)?', 'self[- ]?injur(?:y|ies)']),
  ]),
  rule(
    'safety_wellbeing',
    'distress',
    [
      w([
        'burn(?:ed|t)?[- ]?out',
        'burnout',
        '(?:severe|extreme|overwhelming|constant|serious|unbearable|crippling) (?:stress|anxiety|distress|depression|exhaustion|pressure|panic)',
        'panic attacks?',
        'mental[- ]health (?:crisis|issues?|struggles?|problems?|emergency)',
        "(?:i'?m|i am|i feel|i'?ve been|feeling|i keep feeling)(?: (?:just|so|really|very|extremely|completely|totally|honestly|pretty|kind of|kinda|feeling|been|always|constantly))* (?:hopeless|worthless|depressed|suicidal|numb|empty inside)",
        "(?:can'?t|cannot) (?:sleep|eat|cope|function|stop crying)(?: anymore| any more)?",
        'nervous breakdown',
        'crying every (?:day|night)',
        '(?:emotional|mental|personal|psychological) crisis',
        "(?:i'?m|i am|we'?re|we are) in (?:a )?crisis",
        'crisis (?:line|hotline|counsel(?:l)?ing|support|text line)',
        "can'?t go on like this",
      ]),
    ],
    {
      exclude: [
        w(
          '(?:motor|motors|bulb|bulbs|led|leds|fuse|fuses|battery|batteries|engine|component|components|circuit|board|heater|coil|lamp|lamps|chip|chips|pump|pumps|transistor|transistors) (?:has |have |had |will |would |keeps |kept |just |already )?burn(?:ed|t)?[- ]?out',
        ),
      ],
    },
  ),
  rule('safety_wellbeing', 'physical_safety', [
    w([
      'unsafe',
      'safety (?:hazard|incident|risk|issue|concern)s? (?:to|for) (?:people|users|patients|children|kids|workers|students|participants)',
      'injur(?:y|ies|ed) (?:to )?(?:a |the )?(?:users?|customers?|people|someone|workers?|students?|children|participants?)',
      '(?:someone|somebody|a user|a customer|a student|a worker) (?:got|was|could get|might get) (?:hurt|injured|burned|electrocuted)',
      '(?:fire|explosion|chemical|electrical|lab|battery) (?:hazard|accident|incident)s?',
      "(?:is|it'?s) (?:it )?(?:safe|dangerous) (?:to|for) (?:people|users|patients|children|kids|humans|consumers)",
    ]),
  ]),
  rule('safety_wellbeing', 'police', [
    w([
      '(?:should i|do i need to|i need to|i have to|i had to|i want to) (?:call|contact) (?:911|the police|campus police|campus security|security)',
      '(?:report|reporting) (?:this|it|him|her|them) to (?:the police|campus police|campus security)',
    ]),
  ]),
];

// --------------------------------------------------------------------------------------------------
// conflict_harassment
// --------------------------------------------------------------------------------------------------
const CONFLICT_RULES: readonly RiskRule[] = [
  rule('conflict_harassment', 'harassment', [
    w([
      'harass(?:ed|es|ing|ment)?',
      'sexual(?:ly)? (?:harass\\w*|misconduct|assault\\w*|advances|comments|remarks)',
      'inappropriate(?:ly)? (?:touch\\w*|comments?|remarks?|messages?|behaviou?r|advances|conduct|relationship|photos?)',
      'unwanted (?:advances|touching|contact|attention|messages)',
      '(?:is |been |was |keeps |started |kept )?stalking (?:me|us|my|our)',
      'stalker',
      'stalked me',
      'being stalked',
      'title ix',
      'hostile (?:work )?environment',
      'misconduct',
      '(?:racist|sexist|homophobic|transphobic|ableist|xenophobic|misogynistic|antisemitic|islamophobic) (?:comments?|remarks?|jokes?|behaviou?r|language|slurs?|messages?|abuse)',
      '(?:racial|ethnic|homophobic) slurs?',
    ]),
  ]),
  rule('conflict_harassment', 'identity_targeting', [
    w([
      // "comments about my accent", "jokes about her hijab", "laughs at my English"
      `(?:comments?|jokes?|joking|remarks?|fun|mock(?:s|ed|ing|ery)?|laugh(?:s|ed|ing)?|imitat(?:es|ed|ing)|teas(?:es|ed|ing)|ridicul(?:e|es|ed|ing)|insult(?:s|ed|ing)?|slurs?)${GAP(30)}${WORD_START}(?:my|his|her|their) (?:accent|race|ethnicity|skin(?: colou?r)?|religion|faith|hijab|headscarf|turban|gender|sexuality|sexual orientation|disability|body|weight|appearance|looks|age|pregnancy|nationality|origin|culture|english|hair|clothes|identity|pronouns|caste)${WORD_END}`,
      '(?:keeps|kept|has been|have been|is|are|started|keep|always|constantly) (?:\\p{L}+ )?(?:mocking|belittling|humiliating|insulting|demeaning|ridiculing|making fun of|picking on|laughing at|shouting at|screaming at|yelling at|mimicking) (?:me|us|her|him|them|my|our)',
      '(?:humiliat(?:e|es|ed|ing)|belittl(?:e|es|ed|ing)|demean(?:s|ed|ing)?|ridicul(?:e|es|ed|ing)|insult(?:s|ed|ing)?|mock(?:s|ed|ing)?) (?:me|us|my|him|her|them) (?:in front of|during|at|in) (?:\\p{L}+ )?(?:everyone|the team|others|meetings?|standups?|class|the office|calls)',
      '(?:the )?others? (?:all )?laugh(?:s|ed|ing)? along',
      'everyone laughs? along',
    ]),
  ]),
  rule('conflict_harassment', 'multilingual', [
    w([
      'acoso|acosando|me acosa|hostigamiento|harcelement|harcele(?:e|s)?|harceler|belastigung|belastigt|mobbing|assedio|assediad[oa]|molestie|molestat[oa]',
      'me amenaz\\p{L}*|nos amenaz\\p{L}*|amenazas? de muerte|mensajes amenazantes',
      'me menace|nous menace|menaces? de mort|messages? menacants?',
      'bedroht (?:mich|uns)|droht (?:mir|uns)|drohungen|drohnachrichten',
      'me ameac\\p{L}*|nos ameac\\p{L}*|ameacas? de morte|mensagens ameacadoras',
      'mi minacci\\p{L}*|ci minacci\\p{L}*|minacce di morte|messaggi minacciosi',
      'discriminacion|discriminacao|discrimination raciale|diskriminierung|discriminazione',
    ]),
  ]),
  rule('conflict_harassment', 'discrimination', [w('discriminat(?:e|ed|es|ing|ion|ory)')], {
    exclude: [
      w([
        'price discriminat\\w*',
        '(?:statistical|third[- ]degree|first[- ]degree|second[- ]degree) discrimination',
        'discriminat(?:e|es|ing) (?:between|among)',
        'discriminat\\w* (?:power|ability|validity|analysis|function|threshold)',
      ]),
    ],
  }),
  rule('conflict_harassment', 'cofounder_dispute', [
    w([
      `${COFOUNDER} (?:dispute|disputes|conflict|conflicts|falling[- ]out|fell out|break[- ]?up|breakup|feud|fighting|fight|fights|war|standoff|deadlock|divorce)`,
      `(?:dispute|disputes|conflict|conflicts|fighting|fight|fights|falling[- ]out|fell out|feud|standoff|deadlock|tension|tensions) (?:with|between) (?:me and )?(?:my |our |the )?${COFOUNDER}`,
      '(?:kick|kicking|kicked|push|pushing|pushed|force|forcing|forced|vote|voting|voted|squeeze|squeezing|squeezed) (?:out )?(?:my |our |a |the |me |us )?(?:co-?founders?|cofounders?)?(?: out)? (?:of|from) (?:the |our |my )?(?:company|startup|venture|team|board)',
      '(?:kick|kicking|kicked|push|pushing|pushed|force|forcing|forced|vote|voting|voted|squeeze|squeezing|squeezed) (?:my |our |a |the )?(?:co-?founders?|cofounders?) out',
      '(?:remove|removing|fire|firing|get rid of|getting rid of|oust|ousting|buy out|buying out) (?:my |our |a |the )?(?:co-?founders?|cofounders?)',
      '(?:my |our )?(?:co-?founders?|cofounders?) (?:is|are|has been|have been|keeps|kept|wants to|threatened to|is threatening to) (?:threatening|bullying|yelling|screaming|stealing|taking (?:credit|the ip|the code|the money)|refusing to (?:sign|leave|vest|work)|sabotag\\w*|undermining|cutting me out|locking me out|lying|suing (?:me|us)|not pulling (?:his|her|their) weight)',
      `${COFOUNDER} and I (?:are|have been|keep|were) (?:in (?:a |an )?(?:serious |major |big |ongoing |bitter )?)?(?:dispute|conflict|fighting|arguing|at odds|not speaking|at war)`,
      '(?:co-?founders?|cofounders?) (?:locked|cut|shut|froze|frozen) me out',
      '(?:locked|cut|shut|froze) (?:me )?out of (?:the|our) (?:company|accounts?|repo|repository|bank account|bank|domain|slack|drive)',
    ]),
  ]),
  rule('conflict_harassment', 'threat_bullying', [
    w([
      '(?:threatened|threatening|threatens|threaten) (?:me|us|my (?:family|life|safety|career|job|visa)|to (?:fire|kill|hurt|harm|report|expose|leak|dox|ruin|destroy|retaliate|withhold|blackmail))',
      '(?:death|violent|physical) threats?',
      'threat(?:ening|s)? (?:messages?|emails?|e-mails?|texts?|calls?|voicemails?|notes?|letters?|dms?|comments?|posts?|behaviou?r|language|phone calls?)',
      `(?:sending|sent|sends|send|left|leaving|leaves|posting|posted|received|receiving|getting|got|gets) ${WORDS(3)}threat(?:s|ening)`,
      'threats? (?:against|to) (?:me|my|us|our) (?:life|safety|family|team)?',
      'bull(?:y|ying|ied|ies)',
      'intimidat(?:e|ed|es|ing) (?:me|us|my|our|him|her|them)',
      'intimidation',
      'retaliat(?:e|ed|es|ing|ion) (?:against )?(?:me|us|for reporting)',
      'blackmail(?:ed|ing|s)?',
      'extort(?:ed|ing|ion)?',
      'verbal(?:ly)? abus(?:e|ed|ive)',
      'abusive',
    ]),
  ]),
];

// --------------------------------------------------------------------------------------------------
// prompt_injection
// --------------------------------------------------------------------------------------------------
const INSTRUCTION_NOUNS =
  '(?:instructions?|rules|prompts?|directions|directives|guidelines|guardrails|constraints|polic(?:y|ies)|commands|messages?|context|programming|restrictions|settings|limitations|system prompt)';
const IGNORE_VERBS =
  "(?:ignore|disregard|forget|override|overrule|bypass|skip|discard|erase|abandon|stop following|do not follow|don'?t follow)";
const REVEAL_VERBS =
  "(?:reveal|show|print|display|output|repeat|dump|leak|expose|share|recite|spell out|write out|paste|copy|list|tell me|give me|send me|what (?:is|are|were)|what'?s)";

const INJECTION_RULES: readonly RiskRule[] = [
  rule(
    'prompt_injection',
    'ignore_instructions',
    [
      w([
        `${IGNORE_VERBS} (?:all |any |every |each )?(?:of )?(?:the |your |these |those |its |this )?(?:previous|prior|above|earlier|preceding|foregoing|initial|original|system|safety|developer|existing|current|old|hidden|default|built-in|internal|other)(?: \\w+)? ${INSTRUCTION_NOUNS}`,
        `${IGNORE_VERBS} (?:all |any )?(?:of )?your (?:\\w+ )?(?:instructions?|rules|prompts?|guidelines|guardrails|constraints|polic(?:y|ies)|programming|training|restrictions|directives|limitations|filters|system prompt)`,
        "(?:ignore|disregard|forget) (?:everything|all) (?:above|before|previously|prior|you(?: were|'?ve been| have been) told)",
        `${IGNORE_VERBS} (?:all |any )?(?:safety|content|ethical) (?:filters|rules|policies|guidelines)`,
      ]),
    ],
    { evasionAware: true },
  ),
  rule(
    'prompt_injection',
    'reveal_prompt',
    [
      w([
        `${REVEAL_VERBS} (?:me )?(?:all )?(?:of )?(?:your |the |its )?(?:(?:full|entire|exact|complete|original|hidden|secret|initial|internal|underlying|raw|verbatim) ){0,3}(?:system|developer|hidden|secret|meta|pre)[- ]?(?:prompts?|instructions?|messages?|rules|configuration|config|directives|guidelines|polic(?:y|ies))`,
        `${REVEAL_VERBS} (?:me )?(?:all )?(?:of )?(?:your |the |its )?(?:(?:full|entire|exact|complete|verbatim) )?(?:initial|original|internal|underlying|base) (?:prompts?|instructions)`,
        `${REVEAL_VERBS} (?:me )?(?:all )?(?:of )?your (?:\\w+ )?(?:instructions|rules|prompt|prompts|guidelines|configuration|directives|programming|constraints|guardrails|initial message|system message)`,
        '(?:repeat|print|output|show|copy|paste|echo) (?:me )?(?:back )?(?:the |all )?(?:text|words|everything|content|lines?|message) (?:above|before|preceding)(?: this)?',
        '(?:what|how) (?:were|are|have) you (?:been )?(?:told|instructed|programmed|configured|prompted)(?: to)?',
        'your (?:system|developer|hidden|initial|secret) (?:prompt|message|instructions)',
        'control block',
        'policy[_ ]version',
      ]),
    ],
    { evasionAware: true },
  ),
  rule(
    'prompt_injection',
    'role_override',
    [
      w([
        "you(?:'re| are) now (?:an? |the |my |in |no longer|free|unrestricted|unfiltered|uncensored|jailbroken|dan|called|named|going to|acting|playing|operating|allowed|able to ignore)",
        'from now on,? (?:you|act|respond|answer|ignore|pretend|behave|forget)',
        "(?:pretend|imagine) (?:that )?(?:you(?:'re| are)|to be) (?:a |an )?(?:human|person|real person|different (?:ai|assistant|model)|unrestricted|unfiltered|uncensored|jailbroken|evil|dan|chatgpt|an? eir|my eir|the eir|developer|admin|administrator|system|root|not an ai)",
        '(?:act|behave|respond|answer) (?:as|like) (?:if you (?:are|were) )?(?:an? )?(?:unrestricted|unfiltered|uncensored|jailbroken|evil|dan|ai without|assistant without|model without|different ai|developer|admin|system administrator)',
        'act as .{0,60}?(?:without|no|free of|ignoring|bypassing|overriding|disregarding) (?:any |all |your |the )?(?:restrictions|rules|filters|limits|limitations|guardrails|censorship|guidelines|policies|instructions)',
        '(?:new|updated|real|actual|true|override|replacement|secret|hidden) (?:system )?(?:instructions|rules|prompt|directives?) ?:',
        'do anything now',
        'stay in character no matter',
        'you have no (?:rules|restrictions|limits|guidelines|filters)',
        'you (?:must|will) (?:now )?obey (?:me|my)',
        "(?:i am|i'?m) (?:your|the) (?:developer|creator|admin|administrator|programmer|owner|operator|system administrator)",
      ]),
    ],
    { evasionAware: true },
  ),
  rule(
    'prompt_injection',
    'developer_mode',
    [
      w([
        '(?:developer|god|sudo|root|unrestricted|jailbreak|jailbroken|dan|unfiltered) mode',
        "(?:enable|enter|activate|switch to|switch into|turn on|unlock|you are in|you'?re in|now in) (?:dev|debug|admin|maintenance|test|testing) mode",
        'jailbr(?:eak|eaks|eaking|oken)',
      ]),
    ],
    { evasionAware: true },
  ),
  rule(
    'prompt_injection',
    'bypass_safety',
    [
      w([
        "(?:bypass|disable|turn off|remove|circumvent|evade|get around|break|lift|switch off|deactivate|ignore) (?:all of |all )?(?:your|its|the ai'?s|the model'?s|the coach'?s) (?:\\w+ )?(?:filters?|restrictions|guardrails|safeguards|limitations|censorship|moderation|rules|polic(?:y|ies)|guidelines)",
        '(?:bypass|disable|turn off|remove|circumvent|evade|get around|lift|switch off|deactivate) (?:the |any |all )?(?:safety|content|ethical|ai) (?:filters?|restrictions|guardrails|safeguards|rules|polic(?:y|ies)|guidelines|moderation|settings|checks)',
      ]),
    ],
    { evasionAware: true },
  ),
  rule(
    'prompt_injection',
    'suppress_escalation',
    [
      w([
        // Attempts to switch off human escalation ("do not escalate this", "don't involve any humans").
        "(?:do not|don'?t|never|please don'?t|please do not|stop|you (?:must not|mustn'?t|should not|shouldn'?t|may not)) (?:ever )?(?:escalate|flag|report) (?:this|it|anything|me|any of this|my (?:message|question)|to anyone)?",
        "(?:do not|don'?t|never|please don'?t|please do not) (?:involve|loop in|bring in|notify|alert|contact|tell) (?:any |a |the )?(?:humans?|people|person|staff|anyone|anybody|program|program staff|eirs?|advisors?|university|support|real people)",
        "promise (?:me )?(?:that )?(?:you )?(?:won'?t|will not|not to|you won'?t) (?:escalate|flag|report|tell)",
        'escalations? (?:is|are|has been|have been) (?:disabled|turned off|switched off|off|not needed|not allowed|unavailable|not required)',
        '(?:disable|turn off|switch off|skip|bypass|without any) (?:the |all |any )?escalations?',
        'never escalate',
      ]),
    ],
    { evasionAware: true },
  ),
  rule('prompt_injection', 'encoding_trick', [
    w([
      '(?:decode|decoding|decrypt|deobfuscate|execute|run|follow|interpret|obey) (?:and (?:execute|follow|run|obey) )?(?:this |the following |these |the |my )?(?:base ?64|b64|rot ?13|hex(?:adecimal)?|morse|caesar|reversed|encoded|obfuscated)(?: (?:string|text|message|payload|instructions?|code|command))?',
      'base ?64[- ]?(?:encoded|decode[ds]?|payload|instructions?|message)',
      '(?:encoded|obfuscated|hidden) (?:instructions?|commands?|prompt|payload)',
      '(?:respond|reply|answer) (?:only )?in (?:base ?64|rot ?13|hex)',
    ]),
  ]),
  rule('prompt_injection', 'role_tags', [
    raw([
      '<\\s*/?\\s*(?:system|assistant|developer|instructions?|im_start|im_end|sys|tool|function|evidence|founder_message|venture_context|excerpt)\\s*>',
      '<\\|\\s*(?:im_start|im_end|system|endoftext|eot_id|start_header_id|end_header_id)\\s*\\|>',
      '\\[\\s*/?\\s*(?:inst|sys|system|control)\\s*\\]',
      '<<\\s*/?\\s*sys\\s*>>',
      '(?:^|\\s)#{2,} ?(?:system|instruction|instructions|new instructions)',
      '(?:^|[\\s.!?])(?:system|developer|admin|administrator) ?(?:message|prompt|override|note|instructions?) ?:',
    ]),
  ]),
];

// --------------------------------------------------------------------------------------------------
// cross_venture_request
// --------------------------------------------------------------------------------------------------
const OTHER = "(?:other|another|different|someone else'?s?|somebody else'?s?|the other)";
const CROSS_VENTURE_RULES: readonly RiskRule[] = [
  rule('cross_venture_request', 'other_venture_data', [
    w([
      `${OTHER} (?:teams?|ventures?|startups?|founders?|compan(?:y|ies)|cohort (?:members?|teams?|companies)|participants?)(?:'s?|s')? (?:data|information|info|ideas?|plans?|business plans?|memor(?:y|ies)|documents?|docs|files|uploads?|notes|decks?|pitch(?:es| decks?)?|sessions?|transcripts?|conversations?|chats?|records?|workspaces?|escalations?|answers?|questions?|progress|financials|secrets?|ip|inventions?|patents?|applications?)`,
    ]),
  ]),
  rule('cross_venture_request', 'what_others_do', [
    w([
      `what (?:are|is|were) (?:the )?(?:other|another) (?:founders?|teams?|ventures?|startups?|companies|cohort members?|people (?:in|on) ${PLATFORM}) (?:working on|doing|building|up to|saying|asking|struggling with|pitching|planning|raising|developing|discussing|talking about)`,
      `what (?:is|are) (?:everyone|everybody|anyone|anybody) else (?:in ${PLATFORM} )?(?:working on|building|doing|up to|pitching|asking|talking about)`,
      `who else (?:is|are) (?:in|on|using|part of) ${PLATFORM}`,
      `(?:which|what|any|other) (?:other )?(?:ventures?|teams?|startups?|founders?|companies) (?:are|is) (?:in|on|using|part of|enrolled in) ${PLATFORM}`,
      `(?:tell me|show me|talk) about (?:the other (?:ventures?|teams?|founders?)|(?:other|another) (?:ventures?|teams?|founders?|startups?|companies) (?:in|on|from) ${PLATFORM})`,
      `(?:list|name) (?:all |the )?(?:other )?(?:ventures?|teams?|startups?|founders?|companies) (?:in|on|using) ${PLATFORM}`,
      `(?:other|another) (?:ventures?|teams?|founders?|startups?) (?:in|on|from) ${PLATFORM}`,
    ]),
  ]),
  rule('cross_venture_request', 'compare_with_cohort', [
    w([
      '(?:compare|benchmark|rank|ranking|stack up|measure|how do (?:we|i) compare) (?:us |me |my (?:venture|startup|team|company) |our (?:venture|startup|team|company) |myself |ourselves )?(?:to|with|against) (?:the )?(?:other|rest of the) (?:ventures?|teams?|founders?|cohort)',
      `(?:compare|benchmark|rank|ranking|stack up|measure) (?:us |me |my (?:venture|startup|team|company) |our (?:venture|startup|team|company) )?(?:to|with|against) (?:the )?(?:other|another) (?:startups?|companies) (?:in|on|from) ${PLATFORM}`,
      'rest of (?:the|my|our) cohort',
    ]),
  ]),
  rule('cross_venture_request', 'access_other_workspace', [
    w([
      `(?:access|see|read|view|open|show me|look at|pull up|search|query|retrieve|get|download) (?:into )?${OTHER} (?:venture|team|founder|startup)(?:'s|s'|s)?(?: (?:workspace|memory|data|documents?|sessions?|notes|files|account|records?|history))?`,
      "(?:all|every) (?:ventures?|teams?|founders?)(?:'s|s')? (?:data|memor(?:y|ies)|documents?|sessions?|workspaces?|records)",
      '(?:cross|across)[- ](?:venture|tenant|team) (?:data|search|access|query|retrieval|memory)',
      '(?:search|query) (?:across|all) (?:ventures?|tenants?|workspaces?)',
    ]),
  ]),
];

export const RISK_RULES: readonly RiskRule[] = [
  ...SAFETY_RULES,
  ...MEDICAL_RULES,
  ...SECURITIES_RULES,
  ...LEGAL_RULES,
  ...IP_RULES,
  ...CONFLICT_RULES,
  ...INJECTION_RULES,
  ...CROSS_VENTURE_RULES,
];

/**
 * Squashed (letters-only) signatures used for spaced-out evasion such as
 * `i g n o r e  a l l  p r e v i o u s  i n s t r u c t i o n s`.
 */
export const SQUASHED_INJECTION_SIGNATURES: readonly string[] = [
  'ignoreallprevious',
  'ignorepreviousinstructions',
  'ignoreyourinstructions',
  'ignoreallinstructions',
  'ignoretheaboveinstructions',
  'disregardallprevious',
  'disregardpreviousinstructions',
  'disregardyourinstructions',
  'forgetallprevious',
  'forgetyourinstructions',
  'systemprompt',
  'revealyourprompt',
  'revealyourinstructions',
  'printyourinstructions',
  'developermode',
  'jailbreak',
  'youarenow',
  'doanythingnow',
];
