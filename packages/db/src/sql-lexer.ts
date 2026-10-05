/**
 * A small PostgreSQL lexer that understands exactly what is needed to (1) split migration files into
 * single statements for the RDS Data API and (2) find `:name` placeholders, while skipping
 * string literals ('…', E'…' with backslash escapes, U&'…'), quoted identifiers ("…"), dollar-quoted
 * bodies ($$…$$, $tag$…$tag$), line comments (-- …) and nested block comments.
 *
 * Placeholders are `:` followed by an identifier (`[A-Za-z_][A-Za-z0-9_]*`). `::` casts and the PL/pgSQL
 * `:=` operator are not placeholders. Write array slices with spaces (`arr[lo : hi]`).
 */

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

export interface PlaceholderToken {
  readonly name: string;
  /** Offset of the ':' character. */
  readonly start: number;
  /** Offset just past the name. */
  readonly end: number;
}

export interface SqlScan {
  readonly placeholders: readonly PlaceholderToken[];
  /** Offsets of top-level ';' statement terminators. */
  readonly terminators: readonly number[];
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_CHAR.test(ch);
}

/** Scans SQL once and reports placeholders and statement terminators outside quoted regions. */
export function scanSql(sql: string): SqlScan {
  const placeholders: PlaceholderToken[] = [];
  const terminators: number[] = [];
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // -- line comment
    if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i + 2);
      i = eol === -1 ? n : eol + 1;
      continue;
    }

    // /* block comment */ (PostgreSQL allows nesting)
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }

    // 'string literal' (E'' strings honour backslash escapes; '' is always an escaped quote)
    if (ch === "'") {
      const prev = sql[i - 1];
      const escapeString = (prev === 'E' || prev === 'e') && !isIdentChar(sql[i - 2]);
      i += 1;
      while (i < n) {
        const c = sql[i];
        if (escapeString && c === '\\') {
          i += 2;
          continue;
        }
        if (c === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // "quoted identifier"
    if (ch === '"') {
      i += 1;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // $tag$ dollar-quoted body $tag$ — not when '$' continues an identifier (e.g. a$b) or is $1.
    if (ch === '$' && !isIdentChar(sql[i - 1])) {
      const match = DOLLAR_TAG.exec(sql.slice(i, i + 130));
      if (match) {
        const tag = match[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }

    if (ch === ':') {
      if (next === ':') {
        i += 2; // type cast
        continue;
      }
      if (next !== undefined && IDENT_START.test(next) && sql[i - 1] !== ':') {
        let j = i + 2;
        while (j < n && isIdentChar(sql[j])) j += 1;
        placeholders.push({ name: sql.slice(i + 1, j), start: i, end: j });
        i = j;
        continue;
      }
    }

    if (ch === ';') terminators.push(i);
    i += 1;
  }

  return { placeholders, terminators };
}

/** True when the text holds nothing but whitespace and comments. */
function isBlank(sql: string): boolean {
  let rest = sql;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith('--')) {
      const eol = rest.indexOf('\n');
      rest = eol === -1 ? '' : rest.slice(eol + 1);
      continue;
    }
    if (rest.startsWith('/*')) {
      // Re-use the scanner to find the end of a (possibly nested) block comment.
      let depth = 1;
      let k = 2;
      while (k < rest.length && depth > 0) {
        if (rest[k] === '/' && rest[k + 1] === '*') {
          depth += 1;
          k += 2;
        } else if (rest[k] === '*' && rest[k + 1] === '/') {
          depth -= 1;
          k += 2;
        } else {
          k += 1;
        }
      }
      rest = rest.slice(k);
      continue;
    }
    return rest.length === 0;
  }
}

/**
 * Splits a SQL script into individual statements (without the trailing ';'). Statements that contain only
 * comments/whitespace are dropped. Semicolons inside strings, identifiers, comments and dollar-quoted
 * function bodies do not split. (SQL-standard `BEGIN ATOMIC … END` bodies are not supported; use $$.)
 */
export function splitStatements(sql: string): string[] {
  const { terminators } = scanSql(sql);
  const statements: string[] = [];
  let start = 0;
  for (const end of [...terminators, sql.length]) {
    const piece = sql.slice(start, end);
    if (!isBlank(piece)) statements.push(piece.trim());
    start = end + 1;
  }
  return statements;
}

export type PlaceholderStyle = 'positional' | 'named';

export interface CompiledSql {
  /** SQL text with placeholders rewritten. */
  readonly text: string;
  /** Distinct placeholder names in first-occurrence order (positional: `$1` = names[0]). */
  readonly names: readonly string[];
}

/**
 * Rewrites `:name` placeholders. `render(name, index)` returns the replacement text (index is the 1-based
 * position of the distinct name). Throws via `render` for unknown names.
 */
export function rewritePlaceholders(
  sql: string,
  render: (name: string, index: number) => string,
): CompiledSql {
  const { placeholders } = scanSql(sql);
  if (placeholders.length === 0) return { text: sql, names: [] };
  const order = new Map<string, number>();
  let out = '';
  let last = 0;
  for (const ph of placeholders) {
    let index = order.get(ph.name);
    if (index === undefined) {
      index = order.size + 1;
      order.set(ph.name, index);
    }
    out += sql.slice(last, ph.start) + render(ph.name, index);
    last = ph.end;
  }
  out += sql.slice(last);
  return { text: out, names: [...order.keys()] };
}
