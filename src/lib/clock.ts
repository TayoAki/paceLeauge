export interface Clock {
  /** Wall-clock epoch milliseconds (UTC). */
  now(): number;
  /** Monotonic milliseconds for measuring elapsed time while the process is alive. */
  monotonic(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()),
};
