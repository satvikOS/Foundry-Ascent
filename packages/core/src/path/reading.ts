import { saidNumbers } from './calc.js';
import { asksFor, ownSentences } from './kinds.js';
import {
  bare,
  ideaAs,
  knownFacts,
  lowerFirst,
  sameThing,
  toYou,
  upperFirst,
  type PriorSource,
} from './tell.js';
import { contentStems, plain } from './words.js';

/**
 * What a founder has and what is missing, read from the record by rule: their best proof, with its number and who, and the
 * nearest thing nobody has shown yet, in plain words. It is said where they ask for a judgement (a real business? which
 * money? what will the judges ask?), so the answer is about them and never only about founders in general. Pure.
 */

/** How far what people did goes: nothing, they told of it, they reached for it, one paid, some paid. */
export type ProofLevel = 'none' | 'told' | 'interest' | 'one_paid' | 'some_paid';
const LEVELS: readonly ProofLevel[] = ['none', 'told', 'interest', 'one_paid', 'some_paid'];

export interface Reading {
  readonly level: ProofLevel;
  /** The clause that shows it ("one clinic pays 400 dollars a month"); '' when nothing does. */
  readonly best: string;
  /** How many did it, when they say so. */
  readonly count: number | null;
  /** What was measured beside it ("no-shows went from 18 percent to 11 percent"); ''. */
  readonly measured: string;
  /** Who left ("two left last quarter"); ''. */
  readonly lost: string;
  /** What goes wrong today, in their words; ''. */
  readonly problem: string;
  /** "You have one clinic paying 400 dollars a month." */
  readonly have: string;
  /** "You do not have a second one who pays yet." */
  readonly lacks: string;
}

const NOT_THEIR_DOING =
  /\b(?:would|will|could|might|may|if|should|hopes?|plans?|wants? to pay|nobody|no one|none|not|never|no|zero|free)\b/;
const PAID =
  /\b(?:pays?|paying|paid|bought|buys|(?:they|people|students?|customers?|parents|guests|clients) (?:\w+ )?buy|ordered|orders|pre-?ordered|purchased|subscribed|subscribes|renewed|signed(?! (?:up|in|on|off)\b)|sold(?! for\b| out\b))\b/;
/** What they spend themselves, or what a thing costs, is nobody's payment to them. */
const OWN_SPEND =
  /^(?:you|i|we) (?:(?:have|had|just|also|already) )*(?:paid|pay|spent|bought|ordered)\b|\b(?:sells?|goes|go) for\b|\b(?:rider|courier|supplier|maker|worker)s? (?:gets?|is paid|are paid)\b|\bfor (?:the )?(?:flyers|ads|table|stall|rent)\b/;
const REACHED_FOR =
  /\b(?:asked (?:for|to|when|if|whether|about|how)|wants? (?:a|an|to|it|one|the)|wanted (?:a|an|to|it|one)|would (?:buy|pay|use|try)|said yes|booked|signed up|sign-?ups?|joined|listings?|on (?:a )?(?:free )?trial|uses? it|used it|email address(?:es)?|waitlist|interested|pilots?|opened the page|raised (?:a|their) hand)\b/;
const TOLD =
  /\b(?:said|says|told|described|complained|mentioned|explained|interviewed|interviews?|talked|spoke|conversations?)\b/;
const MEASURED =
  /\b(?:went|fell|dropped|rose|grew|down|up) (?:from )?.{0,40}\bto\b|\b\w+ fewer\b|\bsaved?\b|\bcut\b.{0,30}\bby\b|\bcame back\b|\breturned\b/;
const LEFT =
  /\b(?:left|cancel(?:l)?ed|quit|churned|stopped (?:paying|using|coming)|did not (?:renew|come back))\b/;
/** Friends and family are no proof of a stranger. */
const CLOSE =
  /\b(?:friends?|roommates?|housemates?|flatmates?|family|mom|mum|mother|dad|father|brothers?|sisters?|cousins?|uncles?|aunts?|relatives?|parents)\b/;

const clausesOf = (fact: string): string[] =>
  fact
    .split(
      /\s*;\s*|\.\s+|,\s+(?=(?:and|but|while)\s)|,\s+(?=(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\b)/u,
    )
    .map((c) => bare(c.replace(/^(?:and|but|while)\s+/i, '')))
    .filter((c) => c !== '');

function levelOf(clause: string): ProofLevel {
  // "Asked to a paid tour" is no payment.
  const t = plain(clause).replace(/\b(?:an?|the|our|my|your|one|for|to) (?:paid|signed)\b/g, ' ');
  if (CLOSE.test(t)) return 'none';
  if (
    PAID.test(t) &&
    !OWN_SPEND.test(t) &&
    !NOT_THEIR_DOING.test(t.slice(0, (PAID.exec(t)?.index ?? 0) + 1))
  ) {
    const n = payersIn(clause);
    return n === 1 ? 'one_paid' : 'some_paid';
  }
  if (REACHED_FOR.test(t) || (MEASURED.test(t) && /\d/.test(saidNumbers(clause)))) return 'interest';
  return TOLD.test(t) ? 'told' : 'none';
}

/** How many paid, as a clause says it; null: not said. */
function payersIn(clause: string): number | null {
  const t = saidNumbers(clause);
  const m =
    /(?<![\d.$])(\d+)(?: (?:of|out of) (?:the |my |our )?\d+)?(?: [a-z'-]+){0,4}? (?:(?:now|each|already|have|has) )*(?:pays?|paying|paid|bought|ordered|pre-?ordered|signed|subscribed|renewed|sold)\b/.exec(
      t,
    ) ?? /\b(?:sold|won|signed) (\d+)\b/.exec(t);
  if (m?.[1] !== undefined) return Number(m[1]);
  return /\b(?:a|an|one|1) (?:[a-z'-]+ ){1,3}pays?\b/.test(t) ? 1 : null;
}

const PROBLEM =
  /\b(?:takes? (?:an?|up to|about|over|\w+) ?(?:\w+ )?(?:hours?|days?|weeks?|months?|minutes)|too (?:long|slow|expensive|far|late|loud|hard|many|heavy)|goes? wrong|went wrong|wast(?:e|es|ed|ing)|los(?:e|es|ing)|cannot|can not|no (?:way|place|space|room|time) to|hard to|wait(?:s|ing)?|throw(?:s|n)? (?:\w+ )?(?:out|away)|a mess|breaks? down|forget|nowhere|stuck|pile up|the problem is)\b/;

/** Asked of the coach ("Guarantee me they can't take it away"), never told. */
const ASKED_OF_US =
  /^\W*(?:(?:please|just|so|and|then|ok|okay|come on),? )*(?:guarantee|promise|assure|tell|give|show|cite|say|let|help|explain|convince|prove|swear|admit|make sure|convince|stop|don['’]?t|do not)\b/iu;

/** What goes wrong today, as they told it ("delivery takes an hour on weekends"): never their plan for it. */
export function problemIn(texts: readonly string[], not: readonly string[] = []): string {
  for (const text of texts)
    for (const sentence of ownSentences(text)) {
      if (sentence.trim().endsWith('?') || asksFor(sentence) || ASKED_OF_US.test(sentence)) continue;
      // Their plan, or what they think of it, is cut off it.
      const told = bare(
        sentence.replace(/,?\s+(?:and|so|but)\s+(?:i|we|my|our)(?:['’]\w+)?\s.*$/iu, '').replace(/\s+/g, ' '),
      );
      const t = plain(told);
      if (!PROBLEM.test(t) || /^(?:(?:so|and|but|honestly)[, ]+)*(?:i|we|my|our|it|this|that|they)\b/.test(t))
        continue;
      const words = told.split(' ').length;
      // Their own line of what it is says what they would do, never what goes wrong.
      if (not.some((x) => x.trim().length >= 3 && (t.startsWith(plain(x)) || sameThing(told, x)))) continue;
      if (words < 4 || words > 24 || /\b(?:app|idea|venture|startup|solve[sd]?|will|would)\b/.test(t))
        continue;
      return lowerFirst(toYou(told));
    }
  return '';
}

/** A clause said as something they have ("one clinic pays 400 dollars a month" → "You have one clinic paying 400 dollars…"). */
function haveSaid(clause: string): string {
  const said = bare(clause);
  if (/^you\b/i.test(said)) return `${upperFirst(said)}.`;
  const pays = /^((?:[\p{L}\d'’,-]+ ){1,6}?)pays? (.+)$/u.exec(said);
  // "Four pay 3 dollars": four of what is in the rest of it.
  if (
    pays?.[1] !== undefined &&
    pays[1].trim().split(' ').length >= 2 &&
    /^(?:\d|one|a|an|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|several)\b/iu.test(
      pays[1],
    )
  )
    return `You have ${lowerFirst(pays[1])}paying ${pays[2] ?? ''}.`;
  return `You have this so far: ${lowerFirst(said)}.`;
}

/** What nobody has shown yet that comes next, by how far they are. */
function lacksOf(
  level: ProofLevel,
  args: {
    readonly count: number | null;
    readonly lost: string;
    readonly customer: string;
    readonly leftOver: boolean;
  },
): string {
  switch (level) {
    case 'none':
      return args.customer === ''
        ? 'You have not heard yet, from anyone outside your own circle, about the last time they had this problem.'
        : `You have not heard from ${args.customer} about the last time they had this problem yet.`;
    case 'told':
      return 'You do not have a stranger who paid or signed yet.';
    case 'interest':
      return 'You do not have anyone who paid or signed yet.';
    case 'one_paid':
      return 'You do not have a second one who pays yet.';
    case 'some_paid':
      if (args.lost !== '') return `You do not know yet why the ones who left did (${args.lost}).`;
      if (!args.leftOver) return 'You have not shown yet what one sale leaves over.';
      return args.count !== null && args.count < 10
        ? 'You do not have ten who pay and are not friends yet.'
        : 'You have not shown yet that new ones come without you.';
  }
}

const WHOLE_FACT = 170;

/** What the record shows, read for a judgement. `leftOver`: one sale was worked out already. */
export function readingOf(
  s: PriorSource,
  args: { readonly customer: string | null; readonly leftOver: boolean },
): Reading {
  const facts = knownFacts({ ...s, earlier: [...s.earlier, s.message] });
  let best = { level: 0, clause: '', on: '', fact: '' };
  let lost = '';
  for (const f of facts)
    for (const clause of clausesOf(f.fact)) {
      const level = LEVELS.indexOf(levelOf(clause));
      if (level > best.level || (level === best.level && level > 0 && f.on > best.on))
        best = { level, clause, on: f.on, fact: f.fact };
      if (LEFT.test(plain(clause)) && /\d/.test(saidNumbers(clause)) && !PAID.test(plain(clause)))
        lost = clause;
    }
  const level = LEVELS[best.level] ?? 'none';
  const count = best.clause === '' ? null : payersIn(best.clause);
  // What people said or did before any money, and "four pay" of a fact that says who, is told whole.
  const bareCount = /^(?:only )?[\p{L}\d]+ pays?\b/u.test(best.clause);
  const told = bareCount || level === 'interest' || level === 'told' ? best.fact : '';
  const whole =
    told !== '' && told.length <= WHOLE_FACT && !CLOSE.test(plain(told)) ? bare(told) : best.clause;
  const measured =
    whole !== best.clause
      ? ''
      : (clausesOf(best.fact).find(
          (c) =>
            c !== best.clause && MEASURED.test(plain(c)) && /\d/.test(saidNumbers(c)) && !LEFT.test(plain(c)),
        ) ?? '');
  const problem = problemIn(
    [s.message, ...[...s.earlier].reverse(), s.intake?.block ?? ''],
    [s.venture ?? '', s.oneLiner, s.intake?.idea ?? ''],
  );
  const customer = args.customer === null ? '' : lowerFirst(bare(args.customer));
  return {
    level,
    best: lowerFirst(whole),
    count,
    measured: lowerFirst(measured),
    lost: lowerFirst(lost),
    problem,
    have:
      best.clause !== ''
        ? `${bare(haveSaid(whole))}${measured === '' ? '' : `, and ${lowerFirst(measured)}`}.`
        : problem !== ''
          ? `You have seen one thing: ${problem}.`
          : '',
    lacks: lacksOf(level, { count, lost: lowerFirst(lost), customer, leftOver: args.leftOver }),
  };
}

// What it means for what they ask ------------------------------------------------------------------------------------

/** What a personal answer is made from. */
export interface AnswerSource {
  readonly reading: Reading;
  readonly venture: string;
  /** The idea in their words; ''. */
  readonly idea: string;
  readonly customer: string;
  /** The program's answer, as it is for everyone. */
  readonly answer: string;
  /** They ask a yes-or-no question. */
  readonly yesNo: boolean;
  /** What else they told that bears on it (a price, a trial, a lab). */
  readonly facts: readonly string[];
  readonly message: string;
  /** The conversation said the idea already. */
  readonly ideaSaid?: boolean;
}

export interface PersonalAnswer {
  readonly text: string;
  readonly voice: string;
  /** Said first by the server, word for word: a verdict on them is never left to be paraphrased. */
  readonly opens: boolean;
}

const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?])\s+/u);
const joined = (...parts: readonly string[]): string => parts.filter((p) => p !== '').join(' ');
const said = (r: Reading): string => joined(r.have, r.lacks);

const whoOf = (a: AnswerSource): string => (a.customer === '' ? 'the people you mean' : a.customer);

/** "great", "a real business": what is strong, what is open, and what would settle it. */
function honestRead(a: AnswerSource): PersonalAnswer {
  const { reading: r } = a;
  const about = a.idea === '' ? '' : `, ${ideaAs(a.idea, a.venture)}`;
  const strength =
    r.best !== ''
      ? `Its real strength: ${r.best}${r.measured === '' ? '' : `, and ${r.measured}`}.`
      : r.problem !== ''
        ? `Its real strength: you have seen that ${r.problem}.`
        : `So far there is only the idea${about}: nothing yet shows that anyone wants it.`;
  const risk: Readonly<Record<ProofLevel, string>> = {
    none: `Its real risk: ${whoOf(a)} may like it and still keep doing what they do now. So the first thing to find out is what they did the last time, and what that cost them.`,
    told: 'Its real risk: people name the problem, and nobody has paid to have it gone.',
    interest: 'Its real risk: asking, signing up and liking are not paying, and nobody has paid yet.',
    one_paid:
      'Its real risk: one payer can be the exception, and nobody knows until a second one pays the same price.',
    some_paid:
      r.lost === ''
        ? 'Its real risk: you have not shown that the next ones pay too, and that each sale leaves money over.'
        : `Its real risk: ${r.lost}, and you do not know why.`,
  };
  const test =
    r.level === 'one_paid'
      ? 'A second payer at the same price this month would change my view.'
      : r.level === 'some_paid'
        ? 'The same result from the next ten, with money left on each, would change my view.'
        : 'Ten strangers paying this month, sold to by hand, would change my view.';
  return {
    text: joined('I will not call it great, because neither of us knows yet.', strength, risk[r.level], test),
    voice: joined(
      'I will not call it great yet.',
      r.best !== '' || r.problem !== ''
        ? strength
        : a.idea === ''
          ? 'So far there is only the idea.'
          : `So far I know only the idea: ${bare(ideaAs(a.idea, a.venture))}.`,
      r.level === 'none'
        ? 'Nobody has paid for it, and ten strangers who pay would change my view.'
        : (risk[r.level].split(/(?<=[.])\s/u)[0] ?? ''),
    ),
    opens: true,
  };
}

function realBusiness(a: AnswerSource): PersonalAnswer {
  const { reading: r } = a;
  const opens =
    r.level === 'some_paid'
      ? 'It is becoming one.'
      : r.level === 'one_paid'
        ? 'Not yet, but it has started.'
        : 'Not yet.';
  const have =
    r.have !== ''
      ? r.have
      : a.idea === ''
        ? 'So far it is an idea.'
        : `So far it is an idea: ${bare(ideaAs(a.idea, a.venture))}.`;
  const lacks =
    r.level === 'none' && r.problem !== ''
      ? `You do not know yet whether ${whoOf(a)} would pay to change that.`
      : r.lacks;
  const when =
    'It is a business when strangers pay for it, one sale leaves money over, and you can reach more people like them.';
  const test =
    r.level === 'some_paid' || r.level === 'one_paid'
      ? ''
      : 'So sell 10 by hand this month to people who are not friends, at a real price: if 10 do not buy by hand, software will not fix it.';
  return { text: joined(opens, have, lacks, when, test), voice: joined(opens, have, lacks), opens: true };
}

function willTheyPay(a: AnswerSource): PersonalAnswer | null {
  const { reading: r } = a;
  if (!a.yesNo || r.level === 'none') return null;
  if (r.level === 'one_paid' || r.level === 'some_paid') {
    const opens = r.level === 'one_paid' ? 'One does.' : 'Some do.';
    return { text: joined(opens, said(r)), voice: joined(opens, r.have), opens: true };
  }
  const proof =
    'What people say is a guess, and money is the answer: ask the same people to pay now, at a real price, and count the yeses.';
  return {
    text: joined('That is not proven yet.', said(r), proof),
    voice: joined('That is not proven yet.', r.lacks, 'Ask the same people to pay now.'),
    opens: true,
  };
}

/** Which money, when: by what they can show for it. */
function money(a: AnswerSource): PersonalAnswer {
  const { reading: r } = a;
  const pick =
    r.level === 'some_paid'
      ? 'Your customers first, then a grant or a competition for what they will not pay for; an angel fits once you can say what one amount buys.'
      : r.level === 'one_paid'
        ? 'The second customer first, then a grant or a competition for your next proof; an angel starts to fit when that second one pays.'
        : 'A grant or a campus competition for your next proof, and a customer’s money before any investor’s: an angel or a fund would be buying a guess now.';
  const rest =
    'Grants suit research and early proof, and you keep your shares. Angels suit first customers, and venture capital a venture that must grow very large very fast.';
  return {
    text: joined(
      pick,
      said(r),
      rest,
      'Taking money for shares can be a securities matter, so get advice before you offer any.',
    ),
    voice: joined(pick, r.lacks),
    opens: false,
  };
}

function investorMeeting(a: AnswerSource): PersonalAnswer {
  const { reading: r } = a;
  const [look = ''] = sentencesOf(a.answer);
  const open =
    r.best === ''
      ? 'You have no proof to open with yet, so open with what you test next and its date.'
      : `In this meeting, open with your proof: ${r.best}${r.measured === '' ? '' : `, and ${r.measured}`}.`;
  const gap =
    r.level === 'none'
      ? r.lacks
      : `Then say the gap before they ask: ${lowerFirst(bare(r.lacks)).replace(/^you do not have/, 'you do not have')}.`;
  const rest = sentencesOf(a.answer).slice(1, 3).join(' ');
  return { text: joined(look, open, gap, rest), voice: joined(open, gap), opens: false };
}

function valuation(a: AnswerSource): PersonalAnswer {
  const { reading: r } = a;
  const own =
    r.have === '' && a.idea !== ''
      ? `What you have so far is the idea, ${ideaAs(a.idea, a.venture)}.`
      : r.have;
  const [, second = '', third = ''] = sentencesOf(a.answer);
  return {
    text: joined(
      'Do not put a number on it yet, and do not let me or any website make one up.',
      second,
      third,
      own,
      r.lacks,
      'That is what moves the figure, so get that first, and take the question to your EIR and a startup lawyer before you name one.',
    ),
    voice: joined('Do not put a number on it yet.', own, r.lacks),
    opens: false,
  };
}

/** Which rules a science idea falls under is a specialist's: what it touches says which way to plan. */
function sciencePath(a: AnswerSource): PersonalAnswer {
  const words = plain(`${a.idea} ${a.facts.join(' ')}`);
  const touches =
    /\b(?:patients?|wounds?|burns?|skin|tissue|blood|bodies|body|catheters?|implants?|disease|therapy|treats?|treatment|heals?|clears|dose|clinical|hospital|infection)\b/.test(
      words,
    );
  const tool = /\b(?:assay|reagent|lab tool|microscope|sequenc\w+|software for labs|research tool)\b/.test(
    words,
  );
  const own = a.idea === '' ? 'it' : ideaAs(a.idea, a.venture);
  const pick = touches
    ? `You are on the longer path: ${own}, and something used on a patient is ruled as a device or a drug, never as a lab tool.`
    : tool
      ? `You are on the shorter path if it stays a tool for labs: ${own}.`
      : `It is a science venture: ${own}. What it is for, in one sentence, decides the path.`;
  const rest =
    'So the order is: who owns the work, then which of those rules, then the people who would use and pay for it. Ownership goes to UR Ventures and the rules to a regulatory specialist; the talks are yours, starting this week. Plan on grants before investors.';
  return {
    text: joined(pick, touches ? 'Which of the two is a specialist’s call, not mine.' : '', rest),
    voice: joined(pick, 'Who owns it comes first, then the rules.'),
    opens: false,
  };
}

/** The question judges ask first: at the weak point of their own proof. */
function judges(a: AnswerSource): PersonalAnswer {
  const { reading: r } = a;
  const n = r.count ?? Number(/(?<![\d.$])(\d+)/.exec(saidNumbers(r.best))?.[1] ?? Number.NaN);
  const proof = r.measured === '' ? r.best : `${r.best}, and ${r.measured}`;
  const first =
    r.best === ''
      ? `The first one for you: "Who has paid for this, or told you they have the problem?" You cannot answer it yet, so get three talks before the day.`
      : r.level === 'interest' || r.level === 'told'
        ? `The first one for you: "${Number.isFinite(n) && n > 1 ? `Only ${String(n)}: how` : 'How'} do you know it was your doing, and that someone pays?" Answer with the fact, ${proof}, then what you do next to show it again.`
        : r.level === 'one_paid'
          ? `The first one for you: "One pays. Why would a second?" Answer with the fact, ${proof}, then who you asked next and what they said.`
          : `The first one for you: "What does one sale leave over, and do they stay?" Answer with the fact, ${proof}${r.lost === '' ? '' : `, and say that ${r.lost}`}, then what you do about it.`;
  const rest =
    'Then write the other nine you hope nobody asks, two sentences each: the fact, then what you are doing about it. Cover competitors, why you, what could kill it, who owns it and what you ask for.';
  return { text: joined(first, rest), voice: first, opens: false };
}

const COMPANY =
  /\b(?:hospitals?|clinics?|schools?|departments?|compan(?:y|ies)|shops?|offices?|labs?|count(?:y|ies)|parks?|marinas?|restaurants?|associations?|managers?|makers?|farms?|hotels?|landlords?|rangers|caterers|library|libraries|cities|city)\b/;

/** Whether who buys is a company or an office, by their words. */
export const isCompany = (text: string): boolean => COMPANY.test(plain(text));

/** Which small test first, by the question nobody has answered yet. */
function smallestTest(a: AnswerSource): PersonalAnswer {
  const { reading: r } = a;
  const company = COMPANY.test(plain(`${a.customer} ${a.idea}`));
  const five = a.customer === '' ? 'five people who have the problem' : `five ${a.customer}`;
  const pick =
    r.level === 'none' || r.level === 'told'
      ? `Run this one first: do the job by hand for ${five}, this week, and count who asks for it again. It answers the question that comes first for you, whether anyone wants the result.`
      : r.level === 'interest'
        ? company
          ? 'Run this one first: ask the one who wants it for a small paid trial, with a price, a start day and an end. It answers what comes first for you, whether they pay.'
          : 'Run this one first: sell it before you make more of it, to the people who raised a hand, at a real price. It answers what comes first for you, whether they pay.'
        : 'Run this one first: make the next ten the same offer at the same price and count who pays. It answers what comes first for you, whether it repeats.';
  const own =
    r.best !== ''
      ? said(r)
      : a.idea === '' || a.ideaSaid === true
        ? r.lacks
        : joined(`Your idea is ${ideaAs(a.idea, a.venture)}.`, r.lacks);
  return {
    text: joined(
      pick,
      own,
      'Write the number that counts as a yes before you start: one test, one week, one number.',
    ),
    voice: joined(pick.split(/(?<=\.)\s/u)[0] ?? pick, r.lacks),
    opens: false,
  };
}

/** Who to talk to first, named from their own idea. */
function whoFirst(a: AnswerSource): PersonalAnswer | null {
  if (a.customer === '') return null;
  const rest = sentencesOf(a.answer).slice(2).join(' ');
  const where = `Not everyone, and not all ${/students?\b/.test(a.customer) ? 'students' : `of them`}: go where they were when it happened.`;
  const first = `Talk first to ${a.customer} who had the problem in the last month and tried to fix it.`;
  return {
    text: joined(first, where, rest.replace(/^Describe that one person[^.]*\.\s*/u, '')),
    voice: joined(first, where),
    opens: false,
  };
}

const TRIAL = /\b(?:on (?:a )?(?:free )?trial|asked (?:for|to|when)|wants? (?:a|to|it))\b/;

/** The first customers: the ones who already reached for it. */
function firstCustomers(a: AnswerSource): PersonalAnswer | null {
  const near = a.facts.flatMap(clausesOf).find((c) => TRIAL.test(plain(c)) && !CLOSE.test(plain(c)));
  const { reading: r } = a;
  if (near === undefined && r.level !== 'one_paid' && r.level !== 'some_paid') return null;
  const start =
    near === undefined
      ? `Start from ${r.level === 'one_paid' ? 'the one who pays' : 'the ones who pay'}: ask each for one name like theirs and one sentence on why they said yes.`
      : `Start with the nearest: ${lowerFirst(near)}. Ask them this week for the money, with the price and the day it starts.`;
  const rest =
    'Then list 50 more of the same kind by name, contact 5 a day, and ask for the order at the end of each talk.';
  return { text: joined(start, r.have, rest), voice: joined(start), opens: false };
}

/** Their last result, read for whether to go on. */
function goOn(a: AnswerSource): PersonalAnswer | null {
  const { reading: r } = a;
  const m =
    /(?<![\d.$])(\d+) (?:of|out of) (?:the |my |our )?(\d+)|(?<![\d.$])(\d+)\b[^;.]*?[;,.]? ?(?:only )?(\d+) (?:bought|paid|ordered|said yes|signed)/.exec(
      saidNumbers([r.best, ...a.facts].join('. ')),
    );
  const part = Number(m?.[1] ?? m?.[4]);
  const whole = Number(m?.[2] ?? m?.[3]);
  if (!(part >= 0 && whole > 0 && part <= whole)) {
    // Nothing was tried: there is nothing to stop yet.
    if (r.level !== 'none') return null;
    const what = a.idea === '' ? 'it' : ideaAs(a.idea, a.venture);
    return {
      text: `Neither yet: it is not dead, it is untested. You have told me of no test of ${what}, so there is nothing to stop. Run one this week: offer it to 10 people who are not friends, at a price, and write down first how many must say yes for you to go on. Below that twice, with one change in between, you stop with good reason.`,
      voice:
        'Neither yet: it is not dead, it is untested. Offer it to ten people at a price, and set first how many must say yes.',
      opens: true,
    };
  }
  const share = Math.round((part / whole) * 1000) / 10;
  const head = `${String(part)} of ${String(whole)} bought, which is ${String(share)}%`;
  return {
    text: `Do not decide on this one result. ${head}: ${part === 0 ? 'nobody paid' : 'low, and not zero'}. No number was set first, so it does not say stop, and it does not say go. What decides is a list, not one evening: each test you ran, the number it had to beat, and what came. Stop when two in a row miss a number you wrote first, with one change between them. You have one, and no number, so stopping now would be a mood and not a decision.`,
    voice: `Do not decide on this one result. ${head}, and no number was set first. Stop when two tests in a row miss a number you wrote first.`,
    opens: true,
  };
}

/** The opening of a pitch: one person, then their own number. */
function openPitch(a: AnswerSource): PersonalAnswer | null {
  const { reading: r } = a;
  if (r.best === '' || !/\b(?:open|start|begin|first (?:line|sentence|words?)|hook)\b/.test(plain(a.message)))
    return null;
  const proof = `${r.best}${r.measured === '' ? '' : `, and ${r.measured}`}`;
  return {
    text: `Open with one person and the moment it goes wrong for them, in one sentence. Then your number, at once: ${proof}. Then what you do in five words, and what you ask for. No agenda, no thanks, no market size: the first twenty seconds decide whether they listen.`,
    voice: `Open with one person and the moment it goes wrong, in one sentence. Then your number: ${proof}.`,
    opens: true,
  };
}

/** Ready to leave the program, and where to: by the six lines of the check that their record has evidence for. */
function leavingAin(a: AnswerSource): PersonalAnswer | null {
  const { reading: r } = a;
  const facts = plain([r.best, r.measured, ...a.facts].join('. '));
  const pays = r.level === 'some_paid' || r.level === 'one_paid';
  const lines: readonly (readonly [boolean, string])[] = [
    [pays, 'strangers pay'],
    [
      pays && r.lost === '' && /\b(?:renew\w*|came back|come back|stayed|every month)\b/.test(facts),
      'they come back',
    ],
    [/\bleaves? \$?\d|\bleft (?:per|from|on) (?:each|one)\b|\bmargin\b/.test(facts), 'what one sale leaves'],
    [/\b(?:came|come) (?:from|through|by)\b|\bchannel\b/.test(facts), 'one channel that works'],
    [/\b(?:roles?|who does what)\b/.test(facts), 'written roles in the team'],
    [/\b(?:owns?|ownership|assigned)\b/.test(facts), 'who owns what'],
  ];
  const has = lines.filter(([x]) => x).map(([, x]) => x);
  const lacks = lines.filter(([x]) => !x).map(([, x]) => x);
  const count = ['None', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'][has.length] ?? String(has.length);
  const ready = has.length >= 4;
  const proof = r.best === '' ? '' : ` (${r.best})`;
  const opens = ready
    ? `Yes, by what you have told me: ${count.toLowerCase()} of the six lines of the readiness check have evidence.`
    : `Not yet, by what you have told me. ${count} of the six lines of the readiness check ${has.length === 1 ? 'has' : 'have'} evidence${has.length === 0 ? '' : `, ${has.join(' and ')}${proof}`}.`;
  const missing = lacks.length === 0 ? '' : `Still open: ${lacks.join(', ')}.`;
  const gap =
    r.lost !== ''
      ? `yours is that ${r.lost} and nobody knows why. No incubator or accelerator answers that, your customers do`
      : pays
        ? 'yours is that the next sale does not come without you. No incubator or accelerator fixes that, your customers do'
        : 'yours is a first stranger who pays. No incubator or accelerator gives you that, your customers do';
  const stay = ready
    ? 'So go, with that as the first thing to close.'
    : 'So stay this term and close it. If you must go at the end of it, an incubator fits for space and peers, and an accelerator once the sales repeat.';
  return {
    text: joined(opens, missing, `Where next: the biggest gap picks the place, and ${gap}.`, stay),
    voice: joined(opens, `The biggest gap picks the place, and ${gap}.`),
    opens: true,
  };
}

/** What a founder does all day, put to the one they have. */
function whatFoundersDo(a: AnswerSource): PersonalAnswer | null {
  if (
    !/\bwhat (?:do|does) (?:an? |the )?founders? (?:actually |really |even )?do\b|\bfounders? (?:actually |really )?do all day\b/.test(
      plain(a.message),
    )
  )
    return null;
  const named = a.idea === '' ? 'the idea' : bare(ideaAs(a.idea, a.venture));
  const claim = named.includes(', which ') ? `${named},` : named;
  return {
    text: joined(
      'A founder finds out what is true, one small test at a time: talks to people who have the problem, offers something small for money, and changes one thing from what they did.',
      `Treat it like an experiment: ${claim} is the claim, and what people do is the data.`,
      a.reading.lacks,
      'So your first days go into three talks, and none into building.',
    ),
    voice: `A founder finds out what is true, one small test at a time: ${claim} is the claim, and what people do is the data.`,
    opens: true,
  };
}

const ANSWERS: Readonly<Record<string, (a: AnswerSource) => PersonalAnswer | null>> = {
  'honest-read': honestRead,
  'real-business': realBusiness,
  'will-anyone-pay': willTheyPay,
  'grants-angels-vc': money,
  'raise-or-grow': money,
  'find-investors': money,
  'investor-meeting': investorMeeting,
  valuation,
  'biotech-path': sciencePath,
  'qa-prep': judges,
  'smallest-test': smallestTest,
  'find-ten-people': whoFirst,
  'first-ten-customers': firstCustomers,
  'quit-or-continue': goOn,
  'start-from-zero': whatFoundersDo,
  'leaving-ain': leavingAin,
  'elevator-pitch': openPitch,
};

// What a qualified person decides ------------------------------------------------------------------------------------

const ON_A_DATE =
  /\bon ((?:january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2})\b/i;
const GOES_PUBLIC =
  /\b(?:present(?:ing|s|ation)?|talk|poster|abstract|paper|publish\w*|conference|demo|pitch|competition|defen[cs]e|thesis|fair|expo|exhibit\w*|showcase)\b/i;

/** When it goes public, in their words ("the conference on December 19, and before the abstract"). */
function publicOn(texts: readonly string[]): string {
  for (const text of [...texts].reverse())
    for (const sentence of ownSentences(text)) {
      const day = ON_A_DATE.exec(sentence)?.[1];
      if (day === undefined || !GOES_PUBLIC.test(sentence)) continue;
      const what =
        /\b(conference|talk|poster|paper|demo|pitch|competition|thesis|defen[cs]e|presentation|fair|expo|showcase)\b/i.exec(
          sentence,
        )?.[1];
      const on = `${what === undefined ? '' : `the ${what.toLowerCase()} on `}${day.replace(/^\w/, (c) => c.toUpperCase())}`;
      return /\babstract\b/i.test(sentence) && what !== 'abstract'
        ? `${on}, and before the abstract is out`
        : on;
    }
  return '';
}

/**
 * What can be said at once when they ask for a ruling that a qualified person gives (now or wait? do I sign? may I?): what not
 * to do yet, and until who has said what. Never the ruling. Null: the program's own answer opens with it.
 */
export function holdsAnswer(
  play: { readonly id: string; readonly answer: string },
  args: { readonly texts: readonly string[]; readonly today: string },
): string | null {
  switch (play.id) {
    case 'patent-now-or-wait': {
      const on = publicOn(args.texts);
      const before = on === '' ? 'Before you show how it works to anyone' : `Before ${on}`;
      return `Do not wait to ask, and do not file on your own. ${before}, UR Ventures has to see it, because they decide whether to file, what and when. That day is the reason: once how it works is public, a one-year clock runs in the United States, and most other countries are closed to you. Until they answer, speak about the result and never the method.`;
    }
    case 'sign-ip-form':
      return 'Not yet: sign nothing before UR Ventures, or a lawyer who works for you and not for the lab, has read it. Whether the form itself is a yes or a no is theirs to say.';
    case 'student-ip':
      return 'Do not act on that yet. Who owns it is for UR Ventures to say, from what you used, who paid and what you signed, and nobody in the lab can say it for them.';
    case 'international-student':
      return 'Not before the International Services Office has said so in writing. What counts as work on your visa is theirs to say, and being paid by your own venture can count.';
    default: {
      const [first = ''] = sentencesOf(play.answer);
      return /^(?:do not|not|no\b|never|hire only|grow on|ask before)/i.test(first) ? first : null;
    }
  }
}

/** The plays whose answer is a judgement: what they have and what is missing is said with it. */
export const JUDGEMENT_PLAYS: ReadonlySet<string> = new Set([
  ...Object.keys(ANSWERS),
  'friends-love-it',
  'biggest-reason-to-fail',
  'pivot-or-persevere',
  'term-sheet',
  'pitch-competition',
  'pitch-deck',
  'elevator-pitch',
  'ain-pitch-capstone',
  'leaving-ain',
  'next-home',
  'pricing',
  'price-test',
  'build-first',
  'launch',
  'scaling-readiness',
  'hiring',
  'channel-choice',
  'first-100-users',
  'someone-has-my-idea',
  'b2b-selling',
  'pre-sale',
  'letter-of-intent',
  'pilot-agreement',
]);

/** Judgements of money and customers: while nobody paid, that is what is missing. */
const OF_MONEY: ReadonlySet<string> = new Set([
  'friends-love-it',
  'pricing',
  'price-test',
  'will-anyone-pay',
  'pre-sale',
  'letter-of-intent',
  'pilot-agreement',
  'first-ten-customers',
  'build-first',
  'launch',
  'hiring',
  'b2b-selling',
  'pitch-competition',
  'pitch-deck',
  'elevator-pitch',
  'qa-prep',
]);
/** Judgements of what it is worth: what is missing is what would move it. */
const OF_WORTH: ReadonlySet<string> = new Set([
  'valuation',
  'grants-angels-vc',
  'raise-or-grow',
  'find-investors',
  'investor-meeting',
]);
/** Asks about whom to find, or what happens after: what is missing is said by the answer itself. */
const NO_GAP: ReadonlySet<string> = new Set([
  'biotech-path',
  'term-sheet',
  'find-ten-people',
  'quit-or-continue',
  'start-from-zero',
  'first-100-users',
  'channel-choice',
]);

/** What is missing that matters for this ask; '' when the answer itself is about finding it. */
export function gapFor(playId: string, r: Reading, venture: string): string {
  if (NO_GAP.has(playId)) return '';
  if (r.level === 'one_paid' || r.level === 'some_paid') return r.lacks;
  if (!OF_MONEY.has(playId) && !OF_WORTH.has(playId)) return r.lacks;
  const name = bare(venture);
  const it = name === '' || /^new venture\b/iu.test(name) ? 'it' : name;
  if (OF_WORTH.has(playId))
    return playId === 'valuation'
      ? `No stranger has paid for ${it} yet, and that would move the figure more than any formula.`
      : `No stranger has paid for ${it} yet, and that is the first thing anyone with money asks.`;
  return `No stranger has paid for ${it} yet.`;
}

/** The program's answer to a judgement, made for them; null: it stands as it is. */
export function personalAnswer(playId: string, source: AnswerSource): PersonalAnswer | null {
  const make = ANSWERS[playId];
  if (make === undefined) return null;
  const { reading } = source;
  // What is missing is said once, the same way in the answer and beside it.
  const gap = OF_WORTH.has(playId) && reading.lacks !== '' ? gapFor(playId, reading, source.venture) : '';
  // The answer itself says what that moves.
  const lacks = playId === 'valuation' ? gap.replace(/, and that would move [^.]+/u, '') : gap;
  return make(lacks === '' ? source : { ...source, reading: { ...reading, lacks } });
}

/** Whether a text already says most of another (the reading, said a moment ago). */
export const saysMost = (text: string, part: string): boolean => {
  const words = contentStems(part);
  const held = new Set(contentStems(text));
  return words.length > 0 && words.filter((w) => held.has(w)).length >= words.length * 0.7;
};
