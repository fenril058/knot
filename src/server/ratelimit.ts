export class RateLimiter {
  #limit: number;
  #windowSeconds: number;
  #hits = new Map<string, number[]>();
  #lastSweep = 0;

  constructor(limit: number, windowSeconds: number) {
    this.#limit = limit;
    this.#windowSeconds = windowSeconds;
  }

  get size(): number {
    return this.#hits.size;
  }

  allow(key: string, now: number): boolean {
    const cutoff = now - this.#windowSeconds;
    // 期限切れキーの解放。ウィンドウ内の記録は期限切れになり得ないため、
    // 全走査はウィンドウあたり 1 回までに間引く（毎回走査すると、一回限りの
    // キーを大量に送られたときに allow() 自体が O(n) になり別の DoS になる）。
    if (this.#hits.size > 1024 && now - this.#lastSweep >= this.#windowSeconds) {
      this.#lastSweep = now;
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
