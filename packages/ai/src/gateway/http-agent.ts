import type { ClientRequest, ClientRequestArgs } from 'node:http';
import { Agent } from 'node:https';
import type { Duplex } from 'node:stream';

/**
 * The HTTPS connections the AWS clients (Bedrock: Nova and Titan; Polly) open and reuse, counted for the whole
 * process (LAB-P2: on browser-paced call turns about ten seconds apart, Titan, Bedrock's first token and Polly's
 * first audio were all slower than on back-to-back turns of the same build, which points at new TLS connections per
 * turn). The counts are numbers only; `turn.timing` and the access log report how many each request opened and
 * reused (apps/api request metrics), so a run can tell a cold connection from a slow model.
 */
export interface ConnectionStats {
  /** Connections opened (a TCP and TLS handshake each). */
  readonly opened: number;
  /** Requests sent on a connection kept alive from an earlier one. */
  readonly reused: number;
}

const counts = { opened: 0, reused: 0 };

/** The process-wide connection counts so far (see {@link ConnectionStats}). */
export function awsConnectionStats(): ConnectionStats {
  return { opened: counts.opened, reused: counts.reused };
}

/**
 * How long an idle connection is kept with TCP keep-alive probes (the service may still close it sooner). Long
 * enough to span the gap between two turns of a call, and the gaps of a whole conversation.
 */
export const KEEP_ALIVE_MSECS = 60_000;

/** An HTTPS agent that keeps connections alive and counts what it opens and reuses. */
export class CountingAgent extends Agent {
  override createConnection(
    options: ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    counts.opened += 1;
    return super.createConnection(options, callback);
  }

  override reuseSocket(socket: Duplex, request: ClientRequest): void {
    counts.reused += 1;
    super.reuseSocket(socket, request);
  }
}

let shared: CountingAgent | null = null;

/**
 * The one keep-alive agent every AWS client of the process shares (one pool per host): idle sockets are kept
 * (newest first, so a short burst reuses the warmest), and each counts toward {@link awsConnectionStats}.
 */
export function sharedAwsAgent(): CountingAgent {
  shared ??= new CountingAgent({
    keepAlive: true,
    keepAliveMsecs: KEEP_ALIVE_MSECS,
    maxSockets: 50,
    scheduling: 'lifo',
  });
  return shared;
}
