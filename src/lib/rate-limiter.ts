export class RateLimiterClient {
	// Shared storage keyed by client id (IP or socket key)
	private static store: Map<string, number[]> = new Map();
	private readonly key: string;
	private readonly limit: number;
	private readonly windowMs: number;

	// Accept a key (e.g. IP) so limiting is applied per-key
	constructor(key: string = 'global', _onError?: (err: Error) => void, opts?: { limit?: number; windowMs?: number }) {
		this.key = key;
		this.limit = opts?.limit ?? 5;
		this.windowMs = opts?.windowMs ?? 10_000; // default 10s window
		if (!RateLimiterClient.store.has(this.key)) RateLimiterClient.store.set(this.key, []);
	}

	// Synchronous check used by chat-room.ts: returns true when allowed
	checkLimit(): boolean {
		const now = Date.now();
		const windowStart = now - this.windowMs;
		const timestamps = RateLimiterClient.store.get(this.key)!;
		// remove old timestamps from the front
		while (timestamps.length && timestamps[0] <= windowStart) {
			timestamps.shift();
		}
		if (timestamps.length >= this.limit) return false;
		timestamps.push(now);
		return true;
	}

	// Optional: allow clearing a client's history (not used currently)
	clear() {
		RateLimiterClient.store.set(this.key, []);
	}
}

export default RateLimiterClient;
