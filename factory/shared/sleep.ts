// Timer helper for the daemon's ticket-poll interval, split from main.ts.

/** Resolve after ms milliseconds. */
export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
