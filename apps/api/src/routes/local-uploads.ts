import {
  LOCAL_DOWNLOAD_ROUTE,
  LOCAL_UPLOAD_ROUTE,
  LocalUploadRejectedError,
  type LocalUploadTarget,
} from '../adapters/local-object-store.js';
import { LOCAL_RECORDING_ROUTE, type LocalRecordingTarget } from '../adapters/local-recording-store.js';
import { type RouteBuilder } from '../http/router.js';
import { type AppContext } from '../http/types.js';

const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

function corsHeaders(c: AppContext, method: 'PUT' | 'GET' = 'PUT'): void {
  const origin = c.req.header('origin');
  if (origin !== undefined && LOCAL_ORIGIN.test(origin)) {
    c.header('access-control-allow-origin', origin);
    c.header('access-control-allow-methods', method);
    c.header('access-control-allow-headers', 'content-type');
    c.header('access-control-max-age', '600');
    c.header('vary', 'origin');
  }
}

/**
 * DEVELOPMENT ONLY: the target of LocalObjectStore's presigned URLs, standing in for S3. Authorization is
 * the signed token (key, type, exact length, expiry), exactly like a presigned S3 URL; no session cookie
 * or CSRF header is involved (the browser uploads with a plain XHR PUT). Presigned GETs (the document
 * viewer, downloads) are served the same way. Never mounted in production.
 */
export function registerLocalUploadRoutes(r: RouteBuilder, target: LocalUploadTarget): void {
  r.public(
    'PUT',
    LOCAL_UPLOAD_ROUTE,
    async (c) => {
      corsHeaders(c);
      const declared = Number(c.req.header('content-length') ?? 'NaN');
      if (Number.isFinite(declared) && declared > target.maxUploadBytes) {
        return c.text('upload too large', 413);
      }
      const body = new Uint8Array(await c.req.arrayBuffer());
      if (body.byteLength > target.maxUploadBytes) return c.text('upload too large', 413);
      try {
        await target.receive(c.req.param('token') ?? '', c.req.header('content-type'), body);
      } catch (err) {
        if (err instanceof LocalUploadRejectedError) return c.text(err.message, err.status);
        throw err;
      }
      return c.body(null, 200);
    },
    { developmentOnly: true },
  );
  r.public('OPTIONS', LOCAL_UPLOAD_ROUTE, (c) => {
    corsHeaders(c);
    return Promise.resolve(c.body(null, 204));
  });
  r.public(
    'GET',
    LOCAL_DOWNLOAD_ROUTE,
    async (c) => {
      corsHeaders(c, 'GET');
      try {
        const file = await target.serve(c.req.param('token') ?? '');
        c.header('content-type', file.contentType);
        c.header('content-disposition', file.contentDisposition);
        return c.body(file.body.slice().buffer, 200);
      } catch (err) {
        if (err instanceof LocalUploadRejectedError) return c.text(err.message, err.status);
        throw err;
      }
    },
    { developmentOnly: true },
  );
}

/**
 * DEVELOPMENT ONLY: the target of LocalRecordingStore's presigned URLs, standing in for the recordings bucket. The
 * signed token is the authorization (key, type, exact length for an upload, expiry), exactly like a presigned S3
 * URL. Downloads answer one byte range at a time, so the player seeks as it does against S3. Never mounted in
 * production.
 */
export function registerLocalRecordingRoutes(r: RouteBuilder, target: LocalRecordingTarget): void {
  const cors = (c: AppContext): void => {
    const origin = c.req.header('origin');
    if (origin !== undefined && LOCAL_ORIGIN.test(origin)) {
      c.header('access-control-allow-origin', origin);
      c.header('access-control-allow-methods', 'PUT, GET');
      c.header('access-control-allow-headers', 'content-type, range');
      c.header('access-control-expose-headers', 'content-range, accept-ranges, content-length');
      c.header('access-control-max-age', '600');
      c.header('vary', 'origin');
    }
  };
  r.public(
    'PUT',
    LOCAL_RECORDING_ROUTE,
    async (c) => {
      cors(c);
      const declared = Number(c.req.header('content-length') ?? 'NaN');
      if (Number.isFinite(declared) && declared > target.maxUploadBytes)
        return c.text('upload too large', 413);
      const body = new Uint8Array(await c.req.arrayBuffer());
      if (body.byteLength > target.maxUploadBytes) return c.text('upload too large', 413);
      try {
        await target.receive(c.req.param('token') ?? '', c.req.header('content-type'), body);
      } catch (err) {
        if (err instanceof LocalUploadRejectedError) return c.text(err.message, err.status);
        throw err;
      }
      return c.body(null, 200);
    },
    { developmentOnly: true },
  );
  r.public('OPTIONS', LOCAL_RECORDING_ROUTE, (c) => {
    cors(c);
    return Promise.resolve(c.body(null, 204));
  });
  r.public(
    'GET',
    LOCAL_RECORDING_ROUTE,
    async (c) => {
      cors(c);
      try {
        const file = await target.read(c.req.param('token') ?? '', c.req.header('range'));
        c.header('content-type', file.contentType);
        c.header('accept-ranges', 'bytes');
        c.header('cache-control', 'private, no-store');
        if (file.contentDisposition !== null) c.header('content-disposition', file.contentDisposition);
        if (file.range === null) return c.body(file.body.slice().buffer, 200);
        c.header(
          'content-range',
          `bytes ${String(file.range.start)}-${String(file.range.end)}/${String(file.size)}`,
        );
        return c.body(file.body.slice().buffer, 206);
      } catch (err) {
        if (err instanceof LocalUploadRejectedError) return c.text(err.message, err.status);
        throw err;
      }
    },
    { developmentOnly: true },
  );
}
