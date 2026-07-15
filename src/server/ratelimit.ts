export class RateLimiter {
  #limit: number;
  #windowSeconds: number;
  #hits = new Map<string, number[]>();

  constructor(limit: number, windowSeconds: number) {
    this.#limit = limit;
    this.#windowSeconds = windowSeconds;
  }

  get size(): number {
    return this.#hits.size;
  }

  allow(key: string, now: number): boolean {
    const cutoff = now - this.#windowSeconds;
    if (this.#hits.size > 1024) {
      for (const [hitKey, hits] of this.#hits) {
        if (!hits.some((t) => t > cutoff)) this.#hits.delete(hitKey);
      }
    }
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
