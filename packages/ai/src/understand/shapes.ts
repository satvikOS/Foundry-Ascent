import { nameKey } from './expr.js';
import { inputOf } from './merge-inputs.js';
import type { RawInput } from './schema.js';
import type { SumUnit } from './types.js';

/**
 * Sums of a known shape: the model names the shape and fills its slots with numbers of the founder's, and code writes the
 * expression. `free` is any other sum, written by the model over the numbers it names, and checked the same way.
 */
export const SUM_SHAPES = [
  'cover',
  'hourly',
  'left',
  'ours',
  'stake',
  'total',
  'runway',
  'price',
  'change',
  'rate',
  'chain',
  'free',
] as const;
export type SumShape = (typeof SUM_SHAPES)[number];

/** The slots of each shape, as the prompt names them. */
export const SHAPE_SLOTS: Readonly<Record<Exclude<SumShape, 'free'>, readonly string[]>> = {
  cover: ['fixed', 'target', 'price', 'cost', 'cut', 'ours', 'gain'],
  hourly: ['count', 'price', 'amount', 'cost', 'hours'],
  left: ['count', 'price', 'amount', 'unitcost', 'cost', 'cut'],
  ours: ['count', 'price', 'amount', 'ours', 'cost'],
  stake: ['amount', 'share'],
  total: ['count', 'price', 'amount'],
  runway: ['cash', 'burn', 'income'],
  price: ['cost', 'margin', 'markup'],
  change: ['old', 'new'],
  rate: ['part', 'whole'],
  chain: ['whole', 'share'],
};

/** What a slot holds, in words: what a sum lacks when one is not found. */
const SLOT_WORDS: Readonly<Record<string, string>> = {
  fixed: 'the cost to cover',
  target: 'what you want to make',
  price: 'the price of one',
  cost: 'what it costs you',
  unitcost: 'what one costs you',
  cut: 'the share that is taken',
  ours: 'your share',
  gain: 'what one brings in',
  count: 'how many there are',
  amount: 'the amounts',
  hours: 'the hours it takes',
  share: 'the share',
  cash: 'the money you have',
  burn: 'what goes out a month',
  income: 'what comes in a month',
  margin: 'the share of the price you keep',
  markup: 'what goes on top of the cost',
  old: 'the figure before',
  new: 'the figure now',
  part: 'how many of them',
  whole: 'how many in all',
};

/** A slot's name as the inputs carry it: the role, then which one. */
export const slotWords = (name: string): string | null =>
  /\d$/u.test(name) ? (SLOT_WORDS[nameKey(name).replace(/\d+$/u, '')] ?? null) : null;

/** Slots read as inputs: `price=$11@R2` is input `price1`. */
export function slotsOf(
  slots: readonly string[],
  index: number,
): { readonly inputs: RawInput[]; readonly by: Map<string, string[]> } {
  const inputs: RawInput[] = [];
  const by = new Map<string, string[]>();
  for (const slot of slots) {
    const at = slot.search(/[=:]/u);
    const role = nameKey(at < 0 ? '' : slot.slice(0, at));
    if (role === '') continue;
    const name = `${role}${String(index)}${String((by.get(role) ?? []).length + 1)}`;
    const read = inputOf(`${name}${slot.slice(at)}`);
    if (read === null) continue;
    inputs.push(read);
    by.set(role, [...(by.get(role) ?? []), name]);
  }
  return { inputs, by };
}

const sum = (names: readonly string[]): string | null =>
  names.length === 0 ? null : names.length === 1 ? (names[0] ?? null) : `(${names.join(' + ')})`;
const product = (names: readonly string[]): string | null => (names.length === 0 ? null : names.join(' * '));
const plus = (...parts: readonly (string | null)[]): string | null => {
  const there = parts.filter((p): p is string => p !== null);
  return there.length === 0 ? null : there.length === 1 ? (there[0] ?? null) : `(${there.join(' + ')})`;
};

/** What comes in: so many at a price (counts told in parts add up), and amounts told as they are. */
function income(
  by: ReadonlyMap<string, readonly string[]>,
  counts: 'times' | 'add' = 'times',
): string | null {
  const g = (role: string): readonly string[] => by.get(role) ?? [];
  const price = sum(g('price'));
  const count = counts === 'add' ? sum(g('count')) : product(g('count'));
  const sold = price === null ? null : count === null ? price : `${count} * ${price}`;
  return plus(sold, sum(g('amount')));
}

export interface Built {
  readonly expr: string | null;
  /** The slot it lacks, in words; null: it has what it needs. */
  readonly lacks: string | null;
  readonly unit: SumUnit | null;
  readonly round: 'none' | 'up';
}

const CUT_SAID = /\b(?:cut|drop|fall|fell|less|fewer|lower|shorter|quicker|faster|sooner|saved?|down)\b/iu;
const lacking = (role: string): Built => ({
  expr: null,
  lacks: SLOT_WORDS[role] ?? role,
  unit: null,
  round: 'none',
});

/** The expression of a shape over its slots. */
export function built(
  shape: Exclude<SumShape, 'free'>,
  by: ReadonlyMap<string, readonly string[]>,
  label: string,
): Built {
  const g = (role: string): readonly string[] => by.get(role) ?? [];
  const has = (role: string): boolean => g(role).length > 0;
  const done = (expr: string, unit: SumUnit | null = null, round: 'none' | 'up' = 'none'): Built => ({
    expr,
    lacks: null,
    unit,
    round,
  });
  switch (shape) {
    case 'cover': {
      const owed = plus(sum(g('fixed')), sum(g('target')));
      if (owed === null) return lacking('fixed');
      const price = sum(g('price'));
      const cost = sum(g('cost'));
      const gain =
        sum(g('gain')) ??
        (price === null
          ? null
          : has('ours')
            ? `${price} * ${sum(g('ours')) ?? ''}${cost === null ? '' : ` - ${cost}`}`
            : `${price}${cost === null ? '' : ` - ${cost}`}${has('cut') ? ` - ${price} * ${sum(g('cut')) ?? ''}` : ''}`);
      if (gain === null) return lacking('price');
      return done(`${owed} / (${gain})`, null, 'up');
    }
    case 'hourly': {
      const money = income(by);
      if (money === null) return lacking('price');
      if (!has('hours')) return lacking('hours');
      const cost = sum(g('cost'));
      return done(`(${money}${cost === null ? '' : ` - ${cost}`}) / ${sum(g('hours')) ?? ''}`, '$');
    }
    case 'left': {
      const money = income(by);
      if (money === null) return lacking('price');
      const count = product(g('count'));
      const each = sum(g('unitcost'));
      const costs = [
        ...(each === null ? [] : [count === null ? each : `${count} * ${each}`]),
        ...g('cost'),
        ...(has('cut') ? [`${money} * ${sum(g('cut')) ?? ''}`] : []),
      ];
      return done(costs.length === 0 ? money : `${money} - ${costs.join(' - ')}`, '$');
    }
    case 'ours': {
      const money = income(by);
      if (money === null) return lacking('price');
      if (!has('ours')) return lacking('ours');
      const cost = sum(g('cost'));
      return done(`${money} * ${sum(g('ours')) ?? ''}${cost === null ? '' : ` - ${cost}`}`, '$');
    }
    case 'stake':
      if (!has('amount')) return lacking('amount');
      return has('share')
        ? done(`${sum(g('amount')) ?? ''} / ${sum(g('share')) ?? ''}`, '$')
        : lacking('share');
    case 'total': {
      const money = income(by, 'add');
      return money === null ? lacking('amount') : done(money);
    }
    case 'runway': {
      if (!has('cash')) return lacking('cash');
      if (!has('burn')) return lacking('burn');
      const left = has('income')
        ? `(${sum(g('burn')) ?? ''} - ${sum(g('income')) ?? ''})`
        : (sum(g('burn')) ?? '');
      return done(`${sum(g('cash')) ?? ''} / ${left}`, 'months');
    }
    case 'price': {
      const cost = sum(g('cost'));
      if (cost === null) return lacking('cost');
      if (has('margin')) return done(`${cost} / (1 - ${sum(g('margin')) ?? ''})`, '$');
      return has('markup') ? done(`${cost} * (1 + ${sum(g('markup')) ?? ''})`, '$') : lacking('margin');
    }
    case 'change': {
      const [old, now] = [sum(g('old')), sum(g('new'))];
      if (old === null) return lacking('old');
      if (now === null) return lacking('new');
      return done(CUT_SAID.test(label) ? `(${old} - ${now}) / ${old}` : `(${now} - ${old}) / ${old}`, '%');
    }
    case 'rate': {
      const [part, whole] = [sum(g('part')), sum(g('whole'))];
      if (part === null) return lacking('part');
      return whole === null ? lacking('whole') : done(`${part} / ${whole}`, '%');
    }
    case 'chain': {
      const whole = sum(g('whole'));
      if (whole === null) return lacking('whole');
      return has('share') ? done(`${whole} * ${product(g('share')) ?? ''}`) : lacking('share');
    }
  }
}
