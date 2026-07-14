export class RateLimiter {
  #limit: number;
  #windowSeconds: number;
  #hits = new Map<string, number[]>();

  constructor(limit: number, windowSeconds: number) {
    this.#limit = limit;
    this.#windowSeconds = windowSeconds;
  }

  allow(key: string, now: number): boolean {
    const cutoff = now - this.#windowSeconds;
    const recent = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }
}
