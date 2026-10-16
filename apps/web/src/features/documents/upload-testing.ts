/**
 * Test helpers for uploads (imported by *.test.tsx only): a stand-in XMLHttpRequest for the presigned PUT.
 */

/** A presigned PUT the test finishes, fails or watches being aborted. */
export class FakeXhr {
  static sent: FakeXhr[] = [];
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  withCredentials = true;
  url = '';
  aborted = false;
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {
    return undefined;
  }
  send() {
    FakeXhr.sent.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  succeed() {
    this.status = 200;
    this.onload?.();
  }
  fail() {
    this.onerror?.();
  }
}
