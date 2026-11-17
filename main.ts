// Entry point: connect this server to the trial harness, then wait for it to finish.
//
// The harness tells us where it lives through MAKEFUN_ENV_URL. We start our own
// server on a port the OS picks for us, tell the harness that port, and then keep
// asking it whether the trial is over. When it says yes, we shut down cleanly.
// Nothing else in the program talks to the harness — this file owns that handshake.

import { createApp } from './app.ts';

// The harness origin, with any trailing slashes trimmed off.
const HARNESS = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (HARNESS === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is missing — no harness to talk to\n');
  process.exit(1);
}

// Longest we let one register or poll request run before giving up on it.
const ATTEMPT_TIMEOUT_MS = 30_000;
// Backoff between retries: start here, double each time, never go past the cap.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wait before the next retry: exponential growth from BACKOFF_START_MS, capped. */
function backoffMs(failures: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

/**
 * Tell the harness which port we are listening on. 200 means it heard us; 409
 * means another entry got there first, which is fine — we just keep waiting for
 * the trial to end. 400/405 mean we spoke the wrong protocol, so there is no
 * point retrying. Anything else (dropped connection, odd status) is retried.
 */
async function announce(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${HARNESS}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register rejected with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected with HTTP ')) {
        throw err;
      }
    }
    await wait(backoffMs(failures));
  }
}

/** Ask the harness over and over until it reports the trial is finished. */
async function waitUntilDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${HARNESS}/done`, {
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Harness not reachable or the poll timed out: it is simply not done yet.
    }
    await wait(backoffMs(failures));
  }
}

/** Start the server, register with the harness, wait for the trial to end. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the OS picks a free one. 8080 belongs to the harness, never bind it.
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  process.stdout.write(`[entry] serving on port ${address.port}\n`);

  await announce(address.port);
  process.stdout.write('[entry] registered with the harness\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] trial done, shutting down\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
