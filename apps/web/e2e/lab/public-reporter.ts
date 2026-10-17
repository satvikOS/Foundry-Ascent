import type { FullResult, Reporter, TestCase, TestError, TestResult } from '@playwright/test/reporter';

/**
 * The only reporter the conversation lab prints with (the repository and its Actions logs are public): a test's
 * title (a fixed string written in a spec), its outcome and duration. Error messages, stdout, attachments and
 * steps can quote model output or a transcript, so they are never printed here; they stay in the JSON report,
 * which the lab seals (ops/lab, docs/runbooks/conversation-lab.md).
 */
export default class PublicReporter implements Reporter {
  #counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };

  printsToStdio(): boolean {
    return true;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Retried tests report every attempt; only the final one counts.
    if (result.status !== 'passed' && result.retry < test.retries && result.status !== 'skipped') return;
    const outcome = test.outcome();
    const key = outcome === 'expected' ? 'passed' : outcome === 'unexpected' ? 'failed' : outcome;
    this.#counts[key] += 1;
    const mark = { passed: 'ok', failed: 'FAIL', flaky: 'flaky', skipped: 'skip' }[key];
    const file = test.location.file.split(/[\\/]e2e[\\/]/).pop() ?? '';
    const project = test.parent.project()?.name ?? '';
    const title = test.titlePath().slice(3).join(' > ');
    process.stdout.write(
      `${mark.padEnd(5)} [${project}] ${file} > ${title} (${(result.duration / 1000).toFixed(1)} s)\n`,
    );
  }

  onError(error: TestError): void {
    // The message could quote content; the fact that something failed outside a test is enough here.
    process.stdout.write(
      `error outside a test${error.location ? ` at ${error.location.file.split(/[\\/]/).pop() ?? ''}:${String(error.location.line)}` : ''}\n`,
    );
  }

  onEnd(result: FullResult): void {
    const c = this.#counts;
    process.stdout.write(
      `playwright: ${result.status}; passed ${String(c.passed)}, failed ${String(c.failed)}, flaky ${String(c.flaky)}, skipped ${String(c.skipped)}\n`,
    );
  }
}
