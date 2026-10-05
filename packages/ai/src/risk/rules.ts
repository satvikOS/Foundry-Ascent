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
        "(?:don'?t|do not) want to (?:live|be alive|exist|wake up|be here)(?: anymore| any more)?",
        'no (?:reason|point) (?:to|in) (?:live|living|going on)',
        'better off (?:dead|without me)',
        'not worth living',
        "i (?:can'?t|cannot) go on(?: (?:anymore|any more|any longer|living))?(?=\\s*(?:[.!?,;]|$))",
      ]),
    ],
    {
      crisis: true,
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
        "what'?s the (?:point|use) (?:of|in) (?:living|life|anything|going on|it all|being alive|trying anymore|being here|me)",
        "(?:there'?s|there is) no (?:point|reason) (?:in |to )?(?:anything|living|going on|being alive|trying anymore|being here)",
        'nothing (?:matters|is worth it|means anything) (?:anymore|any more)',
        "(?:i|i'?ve) (?:just |really |sometimes )?(?:want|wanted|wish i could|wish i could just) (?:to )?(?:disappear|vanish|stop existing|not exist|not wake up|sleep forever|fall asleep and (?:never|not) wake up)",
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
  rule(
    'safety_wellbeing',
    'crisis_multilingual',
    [
      w([
        // Spanish
        '(?:quiero|quisiera|me quiero|voy a) (?:morir(?:me)?|matarme|suicidarme|desaparecer|quitarme la vida)',
        'suicid(?:io|arme|arse|a)|quitarme la vida|acabar con mi vida|hacerme dano',
        'no quiero (?:seguir )?(?:vivir|viviendo|estar aqui|despertar)',
        'no (?:le )?veo (?:el )?sentido a (?:nada|la vida|vivir|seguir)',
        '(?:me siento|estoy) (?:muy |tan |completamente )?(?:sin esperanza|desesperanzad[oa])',
        // French
        "(?:je veux|j'ai envie de|je vais) (?:mourir|me tuer|me suicider|disparaitre|en finir)",
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
        '(?:quero|vou) (?:morrer|me matar|sumir)',
        'suicid(?:io|ar)|me matar|tirar (?:a )?minha (?:propria )?vida|acabar com (?:a )?minha vida',
        'nao quero (?:mais )?viver',
        'nao vejo sentido em (?:nada|viver|continuar)',
        '(?:me sinto|estou) (?:tao |muito |completamente )?(?:sem esperanca|desesperad[oa])',
        // Italian
        '(?:voglio|vorrei) (?:morire|uccidermi|suicidarmi|sparire)',
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
