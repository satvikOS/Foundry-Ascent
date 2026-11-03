/** Run the same strict root configuration in bounded workspace processes. */
import { execFileSync, spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const projects = JSON.parse(
  execFileSync('pnpm', ['list', '-r', '--depth=-1', '--json'], { cwd: root, encoding: 'utf8' }),
);
const targets = projects
  .map((project) => relative(root, project.path))
  .filter(Boolean)
  .sort();
if (targets.some((target) => target.startsWith(`..${sep}`) || resolve(root, target) === root)) {
  throw new Error('Unexpected workspace outside the repository.');
}
const config = resolve(root, 'eslint.config.js');
const extra = process.argv.slice(2);
function check(args, label) {
  process.stdout.write(`Lint ${label}\n`);
  const result = spawnSync(
    'pnpm',
    ['exec', 'eslint', '--config', config, '--max-warnings', '0', ...args, ...extra],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
// Keep root scripts and any future non-workspace source in scope. Workspace copies under .claude remain
// excluded by the existing root configuration; each real workspace below receives exactly those same rules.
check(
  ['.', ...targets.flatMap((target) => ['--ignore-pattern', `${target.replaceAll(sep, '/')}/**`])],
  'root',
);
for (const target of targets) check([target], target);
