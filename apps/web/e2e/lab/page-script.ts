/*
 * Functions the lab sends into a page (`page.addInitScript(fn)`, `page.evaluate(fn)`) travel as their SOURCE TEXT,
 * compiled by Playwright's Babel: anything such a function references must be defined inside it. Babel compiles a
 * `#private` class field (and some other syntax) into calls of helpers it defines at the top of the module
 * (`_classPrivateFieldInitSpec`, ...); in the page those do not exist, and the code throws ReferenceError when it
 * runs. Lab run 42112455038 lost its whole LITE arm that way (face-lab-page.ts).
 */

/** Names of the helpers Babel emits outside a function (a function that calls one cannot run in the page alone). */
const BABEL_HELPERS =
  /\b_(?:classPrivate\w*|assertClassBrand|checkPrivateRedeclaration|defineProperty|createClass|classCallCheck|toPropertyKey|toPrimitive|objectSpread2?|asyncToGenerator|regeneratorRuntime|regenerator|inherits|possibleConstructorReturn|getPrototypeOf|wrapNativeSuper|superPropGet|superPropSet|callSuper)\s*\(/;

/**
 * `fn` itself, once its source (what `page.addInitScript` / `page.evaluate` send) is known to run in a page alone:
 * it throws when the compiled source calls a Babel helper defined outside the function.
 */
export function pageScript<T extends (...args: never[]) => unknown>(fn: T): T {
  const source = fn.toString();
  const helper = BABEL_HELPERS.exec(source);
  if (helper !== null) {
    throw new Error(
      `${fn.name || 'page script'} cannot run in a page: its compiled source calls ${helper[0].replace(/\s*\($/, '')}, ` +
        'a helper defined outside the function (avoid #private fields and the like in page scripts)',
    );
  }
  return fn;
}
