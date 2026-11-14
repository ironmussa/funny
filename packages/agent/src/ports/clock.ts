/**
 * Time as the factory sees it. The real clock in production; a fake one in
 * tests, which can move past a token's expiry or a retry delay at once.
 */

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
