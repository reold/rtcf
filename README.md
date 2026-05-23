# Synced Media Room

A real-time synchronized media streaming and chat system built on [Cloudflare Workers](https://workers.cloudflare.com/) and [Durable Objects](https://developers.cloudflare.com/durable-objects/).

## What is this?

Synced Media Room enables multiple users to watch or listen to the same media stream (audio, video, or any timeline-based content) in **perfect synchronization** while chatting in real-time. All clients stay synced even with network latency, and the system automatically handles buffering scenarios to prevent playback skew.

- 🎬 **Media-agnostic**: Works with any timeline-based media (audio, video, streams)
- 🔄 **Real-time sync**: Sub-second latency with server-authoritative state
- 💬 **Built-in chat**: Text messaging with message history persistence
- ⚡ **Serverless**: Runs on Cloudflare Workers with zero maintenance
- 🛡️ **Resilient**: Automatic pause when buffering, resume when ready

## Quick Start

### Development

```bash
npm install
npm run dev
```

Starts a local development server at `http://localhost:8787`

### Deployment

```bash
npm run deploy
```

Deploys to your Cloudflare account.

### Testing

```bash
npm test
```

Runs the test suite.

## How It Works

The system uses a **server-authoritative playback model**:

1. **Clock Synchronization**: Clients sync their clocks with the server to measure latency
2. **Playback Control**: All playback commands (play, pause, seek) flow through the server
3. **Waitlock Mechanism**: If any client buffers, playback pauses and waits for all clients to catch up
4. **Message Persistence**: Chat history is stored and available to new joiners

For a detailed explanation of the architecture, state management, and synchronization algorithm, see [METHODOLOGY.md](./METHODOLOGY.md).

## API Overview

### WebSocket Endpoint

```
GET /room/{roomId}
```

Upgrades to WebSocket at `/websocket`

### Message Types

- **join**: Authenticate and join a room
- **playback**: Control playback (play/pause/seek)
- **buffer_start / buffer_end**: Report buffering status
- **sync_request / sync_reply**: Clock synchronization
- **message**: Send chat message
- **ping**: Keep-alive heartbeat

See [METHODOLOGY.md](./METHODOLOGY.md) for the complete message protocol.

## Technology Stack

- **Runtime**: Cloudflare Workers
- **State**: Durable Objects
- **Language**: TypeScript
- **Testing**: Vitest
- **Package Manager**: pnpm

## Resources

- [Methodology & Design Docs](./METHODOLOGY.md) — Detailed system design, policy, and algorithms
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Durable Objects Docs](https://developers.cloudflare.com/durable-objects/)

## License

See [LICENSE](../LICENSE) file in the project root.
