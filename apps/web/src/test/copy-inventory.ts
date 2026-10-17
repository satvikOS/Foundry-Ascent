import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import ts from 'typescript';

/*
 * An inventory of the words the web app shows, read from its source (TypeScript's parser, no build).
 * copy-inventory.test.ts holds every screen to the word budget in copy-budget.json with it; the copy audit
 * lists every string with its word count from it.
 *
 * What counts as shown:
 *   text        JSX text (`<p>Save changes</p>`)
 *   attribute   a string given to a visible prop (`placeholder`, `label`, `description`, …)
 *   expression  a string in a JSX child expression (`{saving ? 'Saving…' : 'Save'}`)
 *   toast       a toast's message or description
 *   property    a copy-like property in an object (`{ label: 'Knowledge', description: '…' }`)
 *   sentence    any other string literal that reads as a sentence (3+ words, capitalised)
 * Counted apart (never cut for brevity, and not part of a screen's visible total):
 *   name        accessible names (`aria-label`, `alt`, …) and screen-reader-only text (`sr-only`)
 *   tooltip     `title` and tooltip text, and detail behind an info button (`InfoTip`, `info`)
 * A `${…}` substitution counts as one word (it renders as something).
 */

export type CopyKind =
  'text' | 'attribute' | 'expression' | 'toast' | 'property' | 'sentence' | 'name' | 'tooltip';

export const VISIBLE_KINDS: readonly CopyKind[] = [
  'text',
  'attribute',
  'expression',
  'toast',
  'property',
  'sentence',
];

export interface CopyString {
  /** Path relative to apps/web/src, with forward slashes. */
  file: string;
  line: number;
  kind: CopyKind;
  /** The element, prop or key the string belongs to. */
  context: string;
  text: string;
  words: number;
}

/**
 * Words: whitespace-separated tokens with a letter or digit ("—" and "·" are not words); a `${…}`
 * substitution, written "{…}", is one.
 */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]|\{…\}/u.test(token)).length;
}

const NAME_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'alt',
  'srLabel',
  'accessibleName',
]);

/** Props that never carry words (styling, routing, behaviour, data). */
const MACHINE_ATTRIBUTES = new Set([
  'className',
  'class',
  'id',
  'key',
  'type',
  'href',
  'to',
  'from',
  'variant',
  'size',
  'role',
  'name',
  'method',
  'autoComplete',
  'autoCapitalize',
  'autoCorrect',
  'inputMode',
  'enterKeyHint',
  'side',
  'align',
  'value',
  'defaultValue',
  'htmlFor',
  'form',
  'target',
  'rel',
  'src',
  'accept',
  'mode',
  'orientation',
  'tabIndex',
  'testId',
  'as',
  'd',
  'viewBox',
  'fill',
  'stroke',
  'style',
  'lang',
  'dir',
  'pattern',
  'tone',
  'kind',
  'status',
  'icon',
  'layout',
  'position',
  'state',
  'intent',
  'density',
  'slot',
  'activationMode',
  'collisionPadding',
  'sideOffset',
  'shortcut',
  'keys',
]);

/** Object keys whose string values are shown to people. */
const COPY_KEYS = new Set([
  'title',
  'label',
  'description',
  'placeholder',
  'hint',
  'body',
  'empty',
  'emptyText',
  'emptyTitle',
  'emptyBody',
  'message',
  'summary',
  'helper',
  'help',
  'heading',
  'subtitle',
  'caption',
  'tooltip',
  'confirmLabel',
  'cancelLabel',
  'actionLabel',
  'cta',
  'text',
  'detail',
  'lead',
  'note',
  'blurb',
  'short',
  'long',
  'question',
  'answer',
  'explanation',
  'reason',
  'line',
  'headline',
]);

/** Calls whose string arguments are never shown (class names, routing, logging, tests). */
const SILENT_CALLS = new Set([
  'cn',
  'cva',
  'clsx',
  'twMerge',
  'require',
  'fetch',
  'URL',
  'URLSearchParams',
  'RegExp',
  'getElementById',
  'querySelector',
  'querySelectorAll',
  'addEventListener',
  'removeEventListener',
  'setAttribute',
  'getAttribute',
  'matchMedia',
  'createContext',
  'useNavigate',
  'createFileRoute',
  'redirect',
  'startsWith',
  'endsWith',
  'includes',
  'split',
  'join',
  'replace',
  'replaceAll',
  'padStart',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'Intl',
  'DateTimeFormat',
  'NumberFormat',
  'RelativeTimeFormat',
  'PluralRules',
  'localStorage',
  'getItem',
  'setItem',
  'removeItem',
  'postMessage',
  'warn',
  'error',
  'log',
  'debug',
  'info',
  'mark',
  'measure',
]);

/** A string that reads as words rather than a class list, path, key or token. */
export function looksLikeCopy(value: string): boolean {
  const text = value.trim();
  if (!/\p{L}/u.test(text)) return false;
  if (/^(?:https?:|mailto:|\/|\.\/|#|@\/|data:)/.test(text)) return false;
  const tokens = text.split(/\s+/);
  const machineToken = (token: string) => /^[a-z0-9]+(?:[-:_./[\]()%!#=]+[\w./[\]()%!#=-]*)+$/.test(token);
  if (tokens.every((token) => machineToken(token) || /^[a-z]+$/.test(token)) && tokens.some(machineToken)) {
    return false;
  }
  if (tokens.length === 1) {
    // One lowercase token is a key or a value ("ghost", "pending"), not copy.
    return /^\p{Lu}/u.test(text) && !/^[A-Z0-9_]+$/.test(text) && !/[_/]/.test(text);
  }
  return true;
}

function isTypePosition(node: ts.Node): boolean {
  for (let parent = node.parent as ts.Node | undefined; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent) && !ts.isExpressionWithTypeArguments(parent)) return true;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) return false;
  }
  return false;
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) {
    const target = callee.expression;
    const base = ts.isIdentifier(target) ? target.text : '';
    // toast.success(...) → "toast.success"; console.warn(...) → "warn".
    return base === 'toast' ? `toast.${callee.name.text}` : callee.name.text;
  }
  return '';
}

function propertyKey(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return '';
}

/** The literal's text with each `${…}` as "{…}" (one word). */
function literalText(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression) {
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => `{…}${span.literal.text}`)].join('');
  }
  return node.text;
}

type Classified = { kind: CopyKind; context: string } | null;

/** Walk up from a string literal to decide whether, and how, it is shown. */
function classify(literal: ts.Node): Classified {
  let child: ts.Node = literal;
  for (let parent = literal.parent as ts.Node | undefined; parent; child = parent, parent = parent.parent) {
    if (ts.isJsxAttribute(parent)) {
      const name = ts.isIdentifier(parent.name) ? parent.name.text : parent.name.getText();
      const element = parent.parent.parent;
      const tag =
        ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)
          ? element.tagName.getText()
          : '';
      if (NAME_ATTRIBUTES.has(name)) return { kind: 'name', context: name };
      // `title` on an HTML element is a tooltip; on a component it is usually a visible heading.
      if (name === 'title' && /^[a-z]/.test(tag)) return { kind: 'tooltip', context: `${tag} title` };
      if (name === 'content' && tag.includes('Tooltip'))
        return { kind: 'tooltip', context: `${tag} content` };
      // Detail behind an info button (PageHeader's `info`) shows only when opened.
      if (name === 'info') return { kind: 'tooltip', context: `${tag} info` };
      // An info button's subject is only its accessible name ("About …").
      if (tag === 'InfoTip' && name === 'label') return { kind: 'name', context: `${tag} label` };
      if (MACHINE_ATTRIBUTES.has(name) || name.startsWith('data-') || name.startsWith('aria-')) return null;
      if (/^on[A-Z]/.test(name)) return null;
      return { kind: 'attribute', context: `${tag} ${name}` };
    }
    if (ts.isJsxExpression(parent) && (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))) {
      return { kind: 'expression', context: jsxTagName(parent.parent) };
    }
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      const name = calleeName(parent);
      if (name === 'toast' || name.startsWith('toast.')) return { kind: 'toast', context: name };
      if (SILENT_CALLS.has(name)) return null;
      // An argument of any other call: keep walking only through a direct argument (a message helper).
      if (parent.arguments?.includes(child as ts.Expression) !== true) return null;
      continue;
    }
    if (ts.isPropertyAssignment(parent)) {
      if (child === parent.name) return null;
      const key = propertyKey(parent.name);
      if (COPY_KEYS.has(key)) {
        // A toast option ({ description }) is a toast.
        const call = parent.parent.parent;
        if (ts.isCallExpression(call) && calleeName(call).startsWith('toast')) {
          return { kind: 'toast', context: `${calleeName(call)}.${key}` };
        }
        return { kind: 'property', context: key };
      }
      return { kind: 'sentence', context: key || 'property' };
    }
    if (
      ts.isElementAccessExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        /^(?:===|!==|==|!=|in|instanceof)$/.test(parent.operatorToken.getText())) ||
      ts.isCaseClause(parent) ||
      ts.isImportDeclaration(parent) ||
      ts.isExportDeclaration(parent) ||
      ts.isTaggedTemplateExpression(parent)
    ) {
      return null;
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isClassDeclaration(parent)) break;
  }
  return { kind: 'sentence', context: 'literal' };
}

function jsxTagName(node: ts.JsxElement | ts.JsxFragment | ts.Node): string {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return 'fragment';
}

/**
 * Text that is in the page but not on screen: inside an `InfoTip` (shown only when opened) or directly in an
 * element whose class list hides it visually (`sr-only`, read by screen readers only).
 */
function hiddenKind(node: ts.Node): CopyKind | null {
  let nearest = true;
  for (let parent = node.parent as ts.Node | undefined; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) || ts.isSourceFile(parent)) return null;
    if (!ts.isJsxElement(parent)) continue;
    const opening = parent.openingElement;
    if (opening.tagName.getText() === 'InfoTip') return 'tooltip';
    if (nearest) {
      nearest = false;
      const className = opening.attributes.properties.find(
        (prop) => ts.isJsxAttribute(prop) && prop.name.getText() === 'className',
      );
      const value = className && ts.isJsxAttribute(className) ? className.initializer : undefined;
      if (value && ts.isStringLiteral(value) && /(?:^|\s)sr-only(?:\s|$)/.test(value.text)) return 'name';
    }
  }
  return null;
}

/** Every shown string in one source file. */
export function extractCopy(source: string, file: string): CopyString[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: CopyString[] = [];
  const add = (node: ts.Node, shown: CopyKind, context: string, raw: string) => {
    const hidden = shown === 'text' || shown === 'expression' ? hiddenKind(node) : null;
    const kind = hidden ?? shown;
    const text = raw.replace(/\s+/g, ' ').trim();
    const words = countWords(text);
    if (words === 0) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push({ file, line: line + 1, kind, context, text, words });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (!node.containsOnlyTriviaWhiteSpaces) add(node, 'text', jsxTagName(node.parent), node.text);
      return;
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      if (!isTypePosition(node)) {
        const text = literalText(node);
        const where = classify(node);
        if (where && looksLikeCopy(text.replace(/\{…\}/g, ' '))) {
          const sentence = where.kind === 'sentence';
          // A bare literal counts only when it reads as a sentence: 3+ words, capitalised.
          if (!sentence || (countWords(text) >= 3 && /^\p{Lu}/u.test(text.trim()))) {
            add(node, where.kind, where.context, text);
          }
        }
      }
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) visit(span.expression);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Which screen a source file belongs to (the unit of a word budget). */
export function screenOf(file: string): string {
  const rules: [RegExp, string][] = [
    [/^routes\/index\.tsx$|^components\/landing\//, 'Landing'],
    [/^routes\/sign-in\.tsx$|^components\/auth\//, 'Sign-in'],
    [/^features\/chat\/(?:new-chat-page|privacy-choice|first-message)\./, 'New chat'],
    [/^features\/(?:chat|coach)\//, 'Conversation'],
    [/^features\/calls\//, 'Call'],
    [/^features\/(?:knowledge|memory)\//, 'Knowledge'],
    [/^features\/documents\//, 'Documents'],
    [/^features\/escalations\//, 'Human help'],
    [/^features\/venture\/(?:team|invite)/, 'Team'],
    [/^features\/venture\//, 'Venture settings'],
    [/^features\/eir\//, 'Studio'],
    [/^features\/program\//, 'Program'],
    [/^features\/admin\//, 'Admin'],
    [/^components\/(?:shell|a11y)\//, 'Shell'],
    [/^components\/disclosure/, 'Disclosure'],
    [/^components\//, 'Shared UI'],
    [/^routes\//, 'Routes'],
    [/^lib\//, 'Shared (lib)'],
  ];
  return rules.find(([pattern]) => pattern.test(file))?.[1] ?? 'Other';
}

const SKIP =
  /(?:\.test\.tsx?|\.d\.ts|routeTree\.gen\.ts|(?:^|\/)test(?:ing|-utils)\.tsx?|test-fixtures\.ts|(?:^|\/)test\/.*)$/;

/** Every shown string under apps/web/src (tests, fixtures and this module excluded). */
export function inventory(srcRoot: string): CopyString[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  walk(srcRoot);
  return files
    .map((path) => relative(srcRoot, path).split(sep).join('/'))
    .filter((file) => !SKIP.test(file))
    .sort()
    .flatMap((file) => extractCopy(readFileSync(join(srcRoot, file), 'utf8'), file));
}

export interface ScreenTotals {
  screen: string;
  strings: number;
  /** Words of every visible kind. */
  visible: number;
  names: number;
  tooltips: number;
}

export function totalsByScreen(strings: readonly CopyString[]): ScreenTotals[] {
  const totals = new Map<string, ScreenTotals>();
  for (const item of strings) {
    const screen = screenOf(item.file);
    const row = totals.get(screen) ?? { screen, strings: 0, visible: 0, names: 0, tooltips: 0 };
    if (item.kind === 'name') row.names += item.words;
    else if (item.kind === 'tooltip') row.tooltips += item.words;
    else {
      row.visible += item.words;
      row.strings += 1;
    }
    totals.set(screen, row);
  }
  return [...totals.values()].sort((a, b) => a.screen.localeCompare(b.screen));
}
