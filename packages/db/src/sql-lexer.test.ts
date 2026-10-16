import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SqlUsageError } from './errors.js';
import { compileNamed, compilePositional } from './executor.js';
import { MIGRATIONS } from './migrate.js';
import { p } from './params.js';
import { rewritePlaceholders, scanSql, splitStatements } from './sql-lexer.js';

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    const sql = `
      -- leading comment; not a split
      CREATE TABLE a (x text DEFAULT 'semi;colon');
      /* block ; comment /* nested ; */ still comment */
      INSERT INTO a VALUES (E'escaped \\' quote; still string');
      SELECT "weird;identifier" FROM a;
      SELECT 1`;
    expect(splitStatements(sql)).toEqual([
      "-- leading comment; not a split\n      CREATE TABLE a (x text DEFAULT 'semi;colon')",
      "/* block ; comment /* nested ; */ still comment */\n      INSERT INTO a VALUES (E'escaped \\' quote; still string')",
      'SELECT "weird;identifier" FROM a',
      'SELECT 1',
    ]);
  });

  it('keeps $$ and $tag$ function bodies whole', () => {
    const sql = `
CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$
DECLARE x int := 1;
BEGIN
  PERFORM 'a;b';
  RETURN x; -- done;
END
$$;
CREATE FUNCTION g() RETURNS text LANGUAGE sql AS $body$ SELECT $q$;$q$ || ';' $body$;
DO $$ BEGIN RAISE NOTICE 'x;y'; END $$;`;
    const parts = splitStatements(sql);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^CREATE FUNCTION f\(\)[\s\S]*END\n\$\$$/);
    expect(parts[1]).toBe(
      "CREATE FUNCTION g() RETURNS text LANGUAGE sql AS $body$ SELECT $q$;$q$ || ';' $body$",
    );
    expect(parts[2]).toBe("DO $$ BEGIN RAISE NOTICE 'x;y'; END $$");
  });

  it('does not treat positional parameters or identifiers containing $ as dollar quotes', () => {
    expect(splitStatements('SELECT $1; SELECT a$b FROM t; SELECT 2')).toEqual([
      'SELECT $1',
      'SELECT a$b FROM t',
      'SELECT 2',
    ]);
  });

  it('drops empty and comment-only statements', () => {
    expect(splitStatements(';;  -- nothing\n; /* x */ ;')).toEqual([]);
  });

  it('splits the bundled migrations into executable statements matching the SQL files', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const m of MIGRATIONS) {
      const onDisk = readFileSync(join(here, '..', 'migrations', `${m.version}.sql`), 'utf8');
      expect(onDisk.replace(/\r\n/g, '\n')).toBe(m.sql);
      const statements = splitStatements(m.sql);
      // The live migrations 0001–0010 are large; a later one may be small (its own suite pins its count), but
      // it still splits into more than one statement.
      expect(statements.length, m.version).toBeGreaterThan(m.version < '0011' ? 10 : 1);
      for (const s of statements) {
        expect(s.trim()).not.toBe('');
        expect(s.endsWith(';')).toBe(false);
      }
      // Every dollar-quoted body stays intact inside one statement.
      for (const s of statements) expect((s.match(/\$\$/g) ?? []).length % 2).toBe(0);
    }
    const init = splitStatements(MIGRATIONS[0]?.sql ?? '');
    expect(init.some((s) => s.startsWith('DO $$'))).toBe(true);
    const audit = init.find((s) => s.includes('CREATE FUNCTION app.append_audit'));
    expect(audit).toMatch(/LANGUAGE plpgsql[\s\S]*RETURN v_id;\nEND\n\$\$$/);
  });
});

describe('scanSql', () => {
  it('reports placeholders with offsets', () => {
    const { placeholders, terminators } = scanSql('SELECT :a, :b_2; SELECT x::int, :=');
    expect(placeholders.map((ph) => ph.name)).toEqual(['a', 'b_2']);
    expect(placeholders[0]).toMatchObject({ start: 7, end: 9 });
    expect(terminators).toEqual([15]);
  });

  it('handles unterminated constructs without throwing', () => {
    expect(() => scanSql("SELECT 'open")).not.toThrow();
    expect(() => scanSql('SELECT $$ open')).not.toThrow();
    expect(() => scanSql('SELECT /* open')).not.toThrow();
  });
});

describe('RDS Data API safety', () => {
  // The Data API parses `:name` parameters itself; nothing documents that it skips quoted text, comments
  // or function bodies.
  const unsafe = [
    `SELECT to_char(s.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') FROM coaching_sessions s`,
    `SELECT '{"redacted":true}'::jsonb`,
    `SELECT E'line\\n:name'`,
    'SELECT 1 AS "odd:name"',
    '-- a `±hh:mm` offset\nSELECT 1',
    'SELECT 1 /* outer /* nested :inner */ */',
    `CREATE FUNCTION f(p text) RETURNS boolean LANGUAGE sql AS $$ SELECT p ~ '(?:Z|[+-]\\d)' $$`,
    'DO $body$ BEGIN PERFORM 1; -- see :note\nEND $body$',
  ];

  it('finds :name shapes outside placeholders, never in casts, := or offsets', () => {
    expect(unsafe.map((sql) => scanSql(sql).unsafeNames.map((q) => q.name))).toEqual([
      ['MI', 'SS'],
      ['true'],
      ['name'],
      ['name'],
      ['mm'],
      ['inner'],
      ['Z'],
      ['note'],
    ]);
    for (const safe of [
      `SELECT x::text, '2026-10-01 10:00:00+00'::timestamptz, '{"a": 1}', '[:]'`,
      `SELECT 'it''s fine: really', 'a::b'`,
      `SELECT :id WHERE note = 'no colon here'`,
      '-- offsets such as +05:30, casts like x::int\nSELECT 1',
      `CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ DECLARE v int; BEGIN v := 1; RETURN v::int; END $$`,
      `CREATE FUNCTION f(p text) RETURNS boolean LANGUAGE sql AS $$ SELECT p ~ '(?:[Z]|[+-]\\d[:]\\d)' $$`,
    ]) {
      expect(scanSql(safe).unsafeNames).toEqual([]);
    }
    // Placeholders outside quotes are unaffected.
    expect(scanSql(`SELECT :id, 'x:y'`).placeholders.map((ph) => ph.name)).toEqual(['id']);
    expect(scanSql('SELECT :id -- by :id\n').placeholders.map((ph) => ph.name)).toEqual(['id']);
  });

  it('is refused by both drivers before it reaches a database', () => {
    for (const sql of unsafe) {
      expect(() => rewritePlaceholders(sql, () => '?')).toThrow(SqlUsageError);
      expect(() => compileNamed(sql)).toThrow(/RDS Data API/);
      expect(() => compilePositional(sql)).toThrow(/RDS Data API/);
    }
    expect(compileNamed('SELECT :id', { id: p.uuid('6f1c6d0e-1a2b-5c3d-8e4f-0123456789ab') }).text).toBe(
      'SELECT CAST(:id AS uuid)',
    );
  });

  it('holds for every statement of every bundled migration, comments and function bodies included', () => {
    for (const m of MIGRATIONS) {
      for (const statement of splitStatements(m.sql)) {
        expect(scanSql(statement).unsafeNames, `${m.version}: ${statement.slice(0, 60)}`).toEqual([]);
      }
    }
  });
});
