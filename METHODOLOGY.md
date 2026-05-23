# System Policy & Methodology

> **Note**: This document was written by AI based on the system codebase.

## Overview

This is a **real-time synchronized media chat system** built on Cloudflare Workers and Durable Objects. The system enables multiple users to watch/listen to the same media stream (audio, video, or any content with a timeline) in perfect synchronization while maintaining an ongoing text chat, all with sub-second latency and server-authoritative state management.

---

## Core Philosophy

### 1. Server Authority

- The **server (Durable Object) is the single source of truth** for all playback state
- Clients cannot unilaterally change playback state; all commands must flow through the server
- The server validates, timestamps, and broadcasts all state changes
- This prevents clock skew, race conditions, and out-of-sync playback

### 2. Real-Time Synchronization

- All clients synchronize playback position via **server-authoritative timestamps**
- Clock sync mechanism (`sync_request`/`sync_reply`) corrects client-side clock drift
- Position is transmitted with millisecond precision and recalculated on all clients
- The 500ms playback delay ensures all clients have buffered content before play
- **Media-agnostic**: Works with any media format that has a timeline (audio, video, live streams, etc.)

### 3. Resilience Under Buffering

- The **waitlock mechanism** prevents playback advances while any client is buffering
- If a client can't keep up, playback pauses and waits for all clients to catch up
- When resuming, playback starts at the slowest client's position to ensure no one falls behind

### 4. Minimal State Footprint

- Only **playback state** is kept in memory (action, position, timestamp)
- **Message history** is persisted to Durable Object storage (last 50 messages)
- No per-client state persists; clients are stateless and can reconnect anytime

---

## Architecture & Components

### WebSocket Communication

- **Protocol**: JSON-based messages over WebSocket
- **Endpoint**: `GET /room/{roomId}` upgrades to `/websocket`
- **Persistence**: Each room is a unique Durable Object instance
- **Multi-cast**: Server broadcasts all events to all connected clients in the room

### ChatRoom (Durable Object)

The ChatRoom instance manages:

- **Playback State** (`currentPlayback`): Stores `{ action, position, timestamp }`
- **Connected Sessions**: All active WebSocket connections with metadata
- **Message History**: Last 50 messages stored in Durable Object storage
- **Buffering Set**: Tracks which clients are currently buffering

### Rate Limiting

- **Mechanism**: Token bucket (sliding window) per client ID
- **Default**: 5 messages per 10 seconds per client
- **Scope**: Per IP or identified client (prevents DoS)
- **Enforcement**: Silently drops excess messages

### Message Types & Flow

#### Session Management

```
JOIN (client → server → broadcast)
  { type: "join", name: string, clientId: string }
  - First message must be join; server validates
  - Server replies with message history + current state
  - Then broadcasts join notification to all other clients
```

#### Clock Synchronization

```
SYNC_REQUEST (client → server)
  { type: "sync_request", clientTs: number }
SYNC_REPLY (server → client)
  { type: "sync_reply", clientTs: number, serverTs: number }
  - Used to measure latency and adjust for client clock drift
  - Run periodically to keep clocks aligned
```

#### Playback Control

```
PLAYBACK (client → server → broadcast)
  { type: "playback", action: "play"|"pause", position: number }
  - Server adds timestamp with 500ms delay for buffer
  - During waitlock, "play" commands are rejected
  - Pause and seek are always allowed (but subject to waitlock pause)
```

#### Buffer Notifications

```
BUFFER_START (client → server)
  { type: "buffer_start", position: number }
  - Client reports it's buffering at the given position
  - Server engages waitlock if not already active

BUFFER_END (client → server)
  { type: "buffer_end", position: number }
  - Client reports buffering complete
  - Server checks if waitlock should release

POSITION_REPORT (client → server)
  { type: "position_report", position: number }
  - Client reports its current playback position during waitlock
  - Server uses this to pick resume position when lock releases
```

#### Chat Messaging

```
MESSAGE (client → server → broadcast → storage)
  { type: "message", text: string }
  - Rate-limited per client
  - Server timestamps and persists to storage
  - Broadcasts to all clients with server timestamp
```

#### Heartbeat

```
PING (client → server)
  { type: "ping" }
  - Keeps connection alive
  - No response required
```

---

## Playback Synchronization Algorithm

### Phase 1: Startup / Join

1. Client joins room
2. Server sends:
   - Last 50 messages from history
   - Current playback state (adjusted for elapsed time if playing)
   - Current waitlock status (if any)
3. Client initializes UI with this state

### Phase 2: Normal Playback

```
Timeline:
  Client A issues "play" at position 10s
  ↓ [network latency ~50ms]
  Server receives at T0
  ↓
  Server timestamps as T0 + 500ms
  ↓ [network latency ~50ms]
  All clients receive "play" at T0+500 + 50ms ≈ 500ms later
  ↓
  All clients start playback from position 10s at wall time T0+550ms
  ↓
  All clients have synced position because they started at same wall time
```

### Phase 3: Buffering Scenario

```
Client A starts buffering
  ↓
Server receives BUFFER_START
  ↓
Waitlock engages (if first buffer):
  - Pause all clients at current computed position
  - Remember if we were playing (preLockWasPlaying)
  - Broadcast waitlock to all clients
  ↓
Client B also starts buffering (Clients A, B now buffering)
  ↓
Server updates waitlock list, broadcasts updated waiter names
  ↓
Client A finishes buffering (still B buffering)
  ↓
Client B finishes buffering
  ↓
All clients done buffering → waitlock releases:
  - Pick slowest client's position (minPos)
  - Broadcast "waitlock: []" (no more waiters)
  - If we were playing before lock:
    - Timestamp authoritative PLAY at minPos
    - All clients sync and resume playback
```

### Phase 4: Clock Drift Correction

- Clients periodically send `sync_request`
- Server replies with `sync_reply` including:
  - `clientTs`: The timestamp from the client's request
  - `serverTs`: The server's current `performance.now()`
- Client computes latency: `latency = (now - clientTs) / 2`
- Client adjusts playback calculations using latency offset

---

## State Management Policies

### Message History

- **Storage**: Durable Object persistent storage
- **Retention**: Last 50 messages per room
- **Key Format**: ISO 8601 timestamp string
- **Value**: Stringified JSON message object
- **Persistence**: Survives room restarts (Durable Object standard)

### Playback State

- **Storage**: In-memory (not persisted)
- **Content**: `{ action, position, timestamp }`
- **Lifecycle**: Resets when all clients disconnect from room
- **Projection**: Calculated dynamically based on elapsed time since last update

### Session Metadata

- **Per Client**: `{ name, clientId, blockedMessages, lastPosition, buffering }`
- **Storage**: WebSocket attachment (in-memory, per connection)
- **Persistence**: Lost on disconnect
- **Recovery**: Client re-joins and receives full state

### Blocked Messages

- **Purpose**: Queue messages for late-joining clients before they send JOIN
- **Lifetime**: Discarded after client joins
- **Content**: Message history + current room state + active joins

---

## Concurrency & Race Condition Handling

### Problem: Multiple Clients Issuing Commands Simultaneously

**Solution**: Server timestamps with monotonic increment

- Each playback command gets `timestamp = max(now + DELAY, lastTimestamp + 1)`
- This ensures strict ordering even if clients send simultaneously

### Problem: Client A Starts Playing While Client B is Buffering

**Solution**: Waitlock mechanism

- While `bufferingClients.size > 0`, "play" commands are rejected
- Rejected plays are silently dropped (client pauses automatically by default)
- No race condition: buffering set is computed from all live WebSockets

### Problem: Network Reordering (Message A arrives after B)

**Solution**: Timestamp-based ordering on clients

- Clients process messages in timestamp order (or use highest timestamp)
- Out-of-order arrival doesn't corrupt state because timestamps are authoritative

### Problem: Latency Skew Between Clients

**Solution**: Clock sync + Playback delay

- Initial sync_request/sync_reply measures round-trip latency
- Playback position is always adjusted: `position + (wallTime - timestamp) / 1000`
- 500ms buffer ensures all clients finish network propagation before playback starts

---

## Rate Limiting Policy

### Configuration

- **Default Limit**: 5 requests per 10,000ms (10 seconds)
- **Scope**: Per client ID (IP address or identified client)
- **Algorithm**: Sliding window

### Implementation

```typescript
const now = Date.now();
const windowStart = now - windowMs;
// Remove timestamps outside window
while (timestamps.length && timestamps[0] <= windowStart) {
	timestamps.shift();
}
// Check capacity and record new timestamp
if (timestamps.length >= limit) return false; // Dropped
timestamps.push(now);
return true; // Allowed
```

### Application

- Rate limiting is checked **per-client** before processing messages
- Only applies to chat messages (not playback commands, buffer events)
- Clients hitting the limit have their message silently dropped
- No 429 response; design is for WebSocket (which doesn't have standard rate limit codes)

---

## Error Handling & Resilience

### Malformed Messages

- JSON parse errors → silently ignored
- Missing required fields → message dropped

### Unauthenticated Commands

- Commands before JOIN → silently ignored
- JOIN must be first message, format: `{ type: "join", name: string }`

### Invalid Playback Commands

- During waitlock, "play" → silently rejected
- Invalid position values → coerced to 0 or current position

### Buffering Deadlocks

- If a client disconnects while buffering, recomputeBufferingSet removes them
- If all waiters disconnect, waitlock releases immediately
- minPos calculation uses `typeof att.lastPosition === 'number'` check for safety

### Storage Failures

- Storage is async, errors are logged but don't block broadcast
- `ctx.waitUntil()` ensures storage completes before shutdown
- Chat history loss is acceptable; persistence is best-effort

---

## Security & Privacy Policy

### Client Identity

- Clients provide a `name` (nickname, max 32 chars)
- Optional `clientId` (defaults to random UUID)
- **No authentication**: Any user can join any room
- **No encryption**: All messages visible to room participants

### Rate Limiting Scope

- Applied per client, but client ID is NOT verified
- Spoofing is possible (no auth), but per-IP rate limiting mitigates abuse

### Storage Persistence

- Chat history is persisted in Durable Object storage
- Persists indefinitely (no TTL)
- Room data is isolated per room ID (Durable Objects are partitioned)

### WebSocket Security

- Connections are per-user; no shared authentication
- Each session gets unique WebSocket with separate attachment
- No cross-session message leakage by design

---

## Performance Characteristics

### Latency Budget

- **Network Round Trip**: ~50–200ms (typical)
- **Server Processing**: <1ms
- **Total Playback Delay**: 500ms (intentional buffer)
- **Effective Sync Error**: ±250ms (half of network latency)

### Scalability Limits

- **Per Room**: Limited by Durable Object CPU/memory (see Cloudflare limits)
- **Concurrent Connections**: Single DO supports ~100s of concurrent WS connections
- **Message Throughput**: Limited by rate limiter + WebSocket broadcast cost
- **Storage**: 50 message history per room (bounded)

### Optimization Notes

- In-memory playback state avoids storage latency
- Broadcast via `getWebSockets()` is near-constant time
- Sliding window rate limiter is O(n) where n = request count in window (typically small)

---

## Future Considerations & Extension Points

### Potential Enhancements

1. **Multiple Audio Tracks**: Track queue system
2. **Audio Metadata**: Track info, duration, elapsed time
3. **Granular Permissions**: Room visibility, user roles
4. **Persistent User Sessions**: Reconnect with state recovery
5. **Analytics**: Track room activity, user engagement
6. **Server-Side Rendering**: History page, room info
7. **Adaptive Bitrate**: Detect client bandwidth and adjust stream

### Known Limitations

- No authentication (public rooms only)
- No DRM or copy protection
- Audio must be served externally (not through this system)
- 50-message history limit (unbounded with DB)
- No message editing or deletion

---

## Testing Strategy

### Unit Tests

- Rate limiter: Test window sliding, boundary conditions
- Message parsing: Test malformed JSON, type validation
- State transitions: Test waitlock engage/release logic

### Integration Tests

- Multi-client sync: Spawn multiple WebSocket clients, verify sync accuracy
- Buffering scenario: Simulate client buffering, verify lock behavior
- Clock drift: Introduce artificial latency, verify sync correctness
- History recovery: Join late, verify message history + state

### Load Tests

- 100+ concurrent connections per room
- High message rate (hit rate limiter)
- Verify CPU/memory limits on Durable Object

---

## Deployment & Ops

### Deployment

```bash
npm run deploy  # Deploy to Cloudflare
```

### Development

```bash
npm run dev  # Local development with Miniflare
npm test    # Run test suite
```

### Monitoring

- Cloudflare dashboard: CPU/memory usage per worker
- Error tracking: 429s, storage failures, broadcast errors
- User metrics: Connected clients per room, message volume

### Scaling

- Durable Objects auto-shard by room ID
- No central coordination needed
- Add more Cloudflare workers as needed

---

## Glossary

| Term                 | Definition                                                                              |
| -------------------- | --------------------------------------------------------------------------------------- |
| **Playback State**   | `{ action, position, timestamp }` — the authoritative record of play/pause and position |
| **Waitlock**         | Mechanism to pause playback when any client buffers                                     |
| **Clock Sync**       | `sync_request`/`sync_reply` to measure latency and align clocks                         |
| **Blocked Messages** | Queue of messages sent to late-joining clients before they send JOIN                    |
| **Attachment**       | Per-connection metadata stored on WebSocket object                                      |
| **Durable Object**   | Cloudflare persistent state container; one per room                                     |
| **DO Storage**       | Durable Object key-value persistence layer (message history)                            |
