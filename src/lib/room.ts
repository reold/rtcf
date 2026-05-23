import { DurableObject } from 'cloudflare:workers';

interface SessionAttachment {
	name?: string;
	clientId?: string;
	blockedMessages: string[];
	// Last reported playback position (seconds). Used to pick the slowest
	// client's position when releasing a waitlock.
	lastPosition?: number;
	// Whether THIS socket is currently buffering (server-side mirror).
	buffering?: boolean;
}

// Authoritative playback state (in-memory, not persisted).
interface PlaybackState {
	action: 'play' | 'pause';
	position: number; // seconds
	timestamp: number; // server performance.now() when set
}

export class ChatRoom extends DurableObject {
	private lastTimestamp = 0;
	private storage: DurableObjectStorage;
	private currentPlayback: PlaybackState = { action: 'pause', position: 0, timestamp: 0 };

	// ---- Waitlock state ----
	// Set of client names that are currently buffering.
	private bufferingClients = new Set<string>();
	// Were we playing before the waitlock engaged? Determines whether we auto-resume.
	private preLockWasPlaying = false;

	// ---- Hibernation state restoration ----
	// After hibernation the constructor re-runs and all in-memory state is lost.
	// We lazily restore `currentPlayback` from persistent storage on first use.
	private _initialized = false;

	// ---- Storage maintenance ----
	// Counter used to trigger periodic old-message cleanup.
	private messageCount = 0;

	constructor(ctx: DurableObjectState, env: any) {
		super(ctx, env);
		this.storage = ctx.storage;
	}

	// ============== Hibernation helpers ==============

	/**
	 * Restores authoritative playback state from persistent storage.
	 * Must be awaited at the top of every public handler so that state is
	 * correct even after the DO was evicted and re-instantiated.
	 */
	private async ensureInitialized(): Promise<void> {
		if (this._initialized) return;
		this._initialized = true;
		const saved = await this.storage.get<PlaybackState>('__playback');
		if (saved) this.currentPlayback = saved;
	}

	/**
	 * Sets authoritative playback state in memory AND schedules a
	 * persistent write so the value survives hibernation.
	 */
	private updatePlayback(state: PlaybackState): void {
		this.currentPlayback = state;
		this.ctx.waitUntil(this.storage.put('__playback', state));
	}

	// ============== Storage maintenance ==============

	/**
	 * Trims persistent message history to the most recent `maxMessages` entries.
	 * Keys are ISO date strings which sort chronologically.
	 */
	private async trimStorage(maxMessages: number = 500): Promise<void> {
		// List the oldest keys first (alphabetical = chronological).
		const all = await this.storage.list({ limit: maxMessages + 1 });
		if (all.size <= maxMessages) return;
		const keys = [...all.keys()].sort();
		const excess = keys.slice(0, all.size - maxMessages);
		await Promise.all(excess.map((k) => this.storage.delete(k)));
	}

	// ============== Fetch ==============

	fetch(request: Request): Response | Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/websocket') {
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1]);
			const init: SessionAttachment = { blockedMessages: [] };
			pair[1].serializeAttachment(init);
			this.ctx.waitUntil(this.loadHistoryAndSend(pair[1]));
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		return new Response('Not found', { status: 404 });
	}

	private async loadHistoryAndSend(ws: WebSocket): Promise<void> {
		await this.ensureInitialized();

		// If the client already sent a "join" before this background task
		// completed (race condition), the name is set and backlog is stale —
		// skip it.  The client already received history via the join handler.
		const attachment = ws.deserializeAttachment() as SessionAttachment;
		if (attachment.name) return;

		const stored = await this.storage.list({ reverse: true, limit: 50 });
		const backlog = [...stored.values()].reverse() as string[];

		attachment.blockedMessages = backlog;

		for (const other of this.ctx.getWebSockets()) {
			if (other !== ws) {
				const oAtt = other.deserializeAttachment() as SessionAttachment;
				if (oAtt.name) {
					attachment.blockedMessages.push(JSON.stringify({ type: 'join', user: oAtt.name, timestamp: Date.now() }));
				}
			}
		}

		if (this.currentPlayback.timestamp > 0) {
			let { action, position, timestamp } = this.currentPlayback;
			if (action === 'play') {
				const elapsedSec = (performance.now() - timestamp) / 1000;
				position = position + elapsedSec;
				timestamp = performance.now();
			}
			attachment.blockedMessages.push(
				JSON.stringify({
					type: 'playback',
					action,
					position,
					user: 'server',
					timestamp,
				}),
			);
		}

		// If a waitlock is currently active, inform the late-joiner so they pause too.
		if (this.bufferingClients.size > 0) {
			attachment.blockedMessages.push(JSON.stringify({ type: 'waitlock', waiters: [...this.bufferingClients] }));
		}

		ws.serializeAttachment(attachment);
	}

	// ============== WebSocket messages ==============

	async webSocketMessage(ws: WebSocket, raw: string): Promise<void> {
		await this.ensureInitialized();

		const attachment = ws.deserializeAttachment() as SessionAttachment;
		let data: any;
		try {
			data = JSON.parse(raw);
		} catch {
			return;
		}

		// ---------- First message must be "join" ----------
		if (!attachment.name) {
			if (data.type !== 'join' || !data.name) return;
			attachment.name = String(data.name).slice(0, 32);
			attachment.clientId = data.clientId || crypto.randomUUID();
			attachment.buffering = false;
			attachment.lastPosition = 0;
			for (const m of attachment.blockedMessages) ws.send(m);
			attachment.blockedMessages = [];
			ws.serializeAttachment(attachment);
			this.broadcast({ type: 'join', user: attachment.name, timestamp: Date.now() }, ws);
			this.updateUsers();
			return;
		}

		// ---------- Clock sync ----------
		if (data.type === 'sync_request') {
			ws.send(
				JSON.stringify({
					type: 'sync_reply',
					clientTs: data.clientTs,
					serverTs: performance.now(),
				}),
			);
			return;
		}

		// ---------- Buffer reporting (waitlock engine) ----------
		if (data.type === 'buffer_start') {
			if (typeof data.position === 'number') attachment.lastPosition = data.position;
			attachment.buffering = true;
			ws.serializeAttachment(attachment);
			this.onBufferStateChanged();
			return;
		}

		if (data.type === 'buffer_end') {
			if (typeof data.position === 'number') attachment.lastPosition = data.position;
			attachment.buffering = false;
			ws.serializeAttachment(attachment);
			this.onBufferStateChanged();
			return;
		}

		if (data.type === 'position_report') {
			// Periodic position from clients (sent during waitlock so the server
			// can pick the slowest position on release).
			if (typeof data.position === 'number') {
				attachment.lastPosition = data.position;
				ws.serializeAttachment(attachment);
			}
			return;
		}

		// ---------- Playback ----------
		if (data.type === 'playback') {
			const action = data.action;
			const position = typeof data.position === 'number' ? data.position : 0;

			// While a waitlock is engaged, we accept pause/seek but reject `play`.
			// The server will issue the authoritative `play` when the lock releases.
			if (this.bufferingClients.size > 0 && action === 'play') {
				return;
			}

			const PLAYBACK_DELAY_MS = 500;
			const now = performance.now();
			const timestamp = Math.max(now + PLAYBACK_DELAY_MS, this.lastTimestamp + 1);
			this.lastTimestamp = timestamp;

			if (action === 'play' || action === 'pause') {
				this.updatePlayback({ action, position, timestamp });
			}

			// Update sender's known position from any playback message.
			if (typeof position === 'number') {
				attachment.lastPosition = position;
				ws.serializeAttachment(attachment);
			}

			this.broadcast(
				JSON.stringify({
					type: 'playback',
					action,
					position,
					user: attachment.name,
					timestamp,
				}),
			);
			return;
		}

		// ---------- Heartbeat ----------
		if (data.type === 'ping') return;

		// ---------- Chat ----------
		if (data.type === 'message') {
			const text = String(data.text || '').slice(0, 1024);
			const wallTs = Date.now();
			const msg = JSON.stringify({
				type: 'message',
				user: attachment.name,
				text,
				timestamp: wallTs,
			});
			this.broadcast(msg);
			await this.storage.put(new Date(wallTs).toISOString(), msg);
			this.messageCount++;
			if (this.messageCount % 50 === 0) {
				this.ctx.waitUntil(this.trimStorage());
			}
			return;
		}

		// ---------- Other (e.g. "stream") ----------
		const wallTs = Date.now();
		const payload = JSON.stringify({
			...data,
			user: attachment.name,
			timestamp: wallTs,
		});
		this.broadcast(payload);
		if (data.type !== 'stream') {
			await this.storage.put(new Date(wallTs).toISOString(), payload);
			this.messageCount++;
			if (this.messageCount % 50 === 0) {
				this.ctx.waitUntil(this.trimStorage());
			}
		}
	}

	// ============== Waitlock engine ==============

	private recomputeBufferingSet(): void {
		this.bufferingClients.clear();
		for (const ws of this.ctx.getWebSockets()) {
			const att = ws.deserializeAttachment() as SessionAttachment;
			if (att.name && att.buffering) this.bufferingClients.add(att.name);
		}
	}

	private onBufferStateChanged(): void {
		const wasLocked = this.bufferingClients.size > 0;
		this.recomputeBufferingSet();
		const nowLocked = this.bufferingClients.size > 0;

		if (!wasLocked && nowLocked) {
			// LOCK ENGAGE: remember whether we were playing, force-pause everyone.
			this.preLockWasPlaying = this.currentPlayback.action === 'play';
			// Record authoritative pause state at "now-projected" position.
			if (this.preLockWasPlaying) {
				const elapsedSec = (performance.now() - this.currentPlayback.timestamp) / 1000;
				this.updatePlayback({
					action: 'pause',
					position: this.currentPlayback.position + elapsedSec,
					timestamp: performance.now(),
				});
			}
			this.broadcast(
				JSON.stringify({
					type: 'waitlock',
					waiters: [...this.bufferingClients],
				}),
			);
			return;
		}

		if (wasLocked && nowLocked) {
			// Still locked, just the set changed — notify so UI can update names.
			this.broadcast(
				JSON.stringify({
					type: 'waitlock',
					waiters: [...this.bufferingClients],
				}),
			);
			return;
		}

		if (wasLocked && !nowLocked) {
			// LOCK RELEASE: pick the slowest client's position and resume.
			let minPos = Infinity;
			for (const ws of this.ctx.getWebSockets()) {
				const att = ws.deserializeAttachment() as SessionAttachment;
				if (att.name && typeof att.lastPosition === 'number') {
					minPos = Math.min(minPos, att.lastPosition);
				}
			}
			if (!isFinite(minPos)) minPos = this.currentPlayback.position;

			// Always release the lock first.
			this.broadcast(JSON.stringify({ type: 'waitlock', waiters: [] }));

			if (this.preLockWasPlaying) {
				// Schedule a synchronized play at minPos with the standard 500ms buffer.
				const PLAYBACK_DELAY_MS = 500;
				const now = performance.now();
				const timestamp = Math.max(now + PLAYBACK_DELAY_MS, this.lastTimestamp + 1);
				this.lastTimestamp = timestamp;
				this.updatePlayback({ action: 'play', position: minPos, timestamp });
				this.broadcast(
					JSON.stringify({
						type: 'playback',
						action: 'play',
						position: minPos,
						user: 'server',
						timestamp,
					}),
				);
			} else {
				// Wasn't playing before — leave paused but sync everyone to minPos.
				const PLAYBACK_DELAY_MS = 500;
				const now = performance.now();
				const timestamp = Math.max(now + PLAYBACK_DELAY_MS, this.lastTimestamp + 1);
				this.lastTimestamp = timestamp;
				this.updatePlayback({ action: 'pause', position: minPos, timestamp });
				this.broadcast(
					JSON.stringify({
						type: 'playback',
						action: 'seek',
						position: minPos,
						user: 'server',
						timestamp,
					}),
				);
			}
			this.preLockWasPlaying = false;
		}
	}

	// ============== Lifecycle ==============

	async webSocketClose(ws: WebSocket): Promise<void> {
		await this.ensureInitialized();
		const att = ws.deserializeAttachment() as SessionAttachment;
		if (att.name) {
			this.broadcast({ type: 'leave', user: att.name, timestamp: Date.now() });
			// If the leaver was holding up the lock, recompute.
			if (att.buffering) this.onBufferStateChanged();
		}
		await this.updateUsers();
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.webSocketClose(ws);
	}

	private broadcast(data: unknown, exclude?: WebSocket): void {
		const raw = typeof data === 'string' ? data : JSON.stringify(data);
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === exclude) continue;
			const att = ws.deserializeAttachment() as SessionAttachment;
			if (att.name) {
				ws.send(raw);
			} else {
				// Cap blocked messages for unauthenticated sockets to prevent
				// unbounded memory growth if a client connects but never sends "join".
				if (att.blockedMessages.length < 200) {
					att.blockedMessages.push(raw);
					ws.serializeAttachment(att);
				}
			}
		}
	}

	private async updateUsers(): Promise<void> {
		const users: string[] = [];
		for (const ws of this.ctx.getWebSockets()) {
			const att = ws.deserializeAttachment() as SessionAttachment;
			if (att.name) users.push(att.name);
		}
		this.broadcast({ type: 'users', users, timestamp: Date.now() });
	}
}
