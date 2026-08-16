# Media Transport Protocol — dspeak-media-control

This document specifies the media transport protocol (version 919, contract revision 5) used between clients and the `dspeak-media-control` Durable Object.

## Protocol Overview

- **Protocol ID**: 919 (permanent product identifier)
- **Contract Revision**: 5
- **Handshake Keywords**: `hello919` (client), `hi919` (server), `error919` (error)
- **Transport**: WebSocket (control plane only, no media packets)

## Message Types

### Client → Server

| Type                      | Purpose                                 |
| ------------------------- | --------------------------------------- |
| `hello919`                | Authentication with media ticket        |
| `media-sources`           | Source state mutations with generation  |
| `heartbeat`               | Liveness + source digest reconciliation |
| `p2p-signal`              | WebRTC signaling for P2P mesh           |
| `p2p-ready`               | P2P qualification result                |
| `media-capabilities`      | Client media capabilities               |
| `participant-voice-state` | Mute/deafen state                       |
| `leave`                   | Clean departure                         |
| `request-snapshot`        | Request full room snapshot              |
| `cloudflare-publication`  | Cloudflare Realtime publication updates |

### Server → Client

| Type                               | Purpose                                                     |
| ---------------------------------- | ----------------------------------------------------------- |
| `hi919`                            | Welcome with connection epoch, room revision                |
| `topology-state`                   | Canonical topology (epoch, sourceRevision, peers, provider) |
| `route-commit`                     | Committed route for activation                              |
| `operation-ack`                    | Acknowledgment for state-changing operations                |
| `state-nack`                       | Negative acknowledgment with canonical state                |
| `heartbeat-ack`                    | Heartbeat acknowledgment                                    |
| `error919`                         | Error response (non-fatal or fatal)                         |
| `provider-ticket`                  | Short-lived provider authorization                          |
| `cloudflare-publication-available` | Remote publication notification                             |
| `p2p-signal-relay`                 | Relayed P2P signaling                                       |
| `participant-capabilities`         | Remote participant capabilities                             |
| `provider-failure`                 | Provider failure notification                               |
| `provider-recovering`              | Provider recovery with retry timing                         |

## Connection Epoch

- **Server-owned, per-participant**: Assigned on attach, incremented on reattach
- **Persisted**: In DO durable storage across hibernation
- **Never client-controlled**: Client never sends epoch in hello
- **Scoped**: All state mutations require current epoch
- **Included in**: `hi919`, `operation-ack` (for MEDIA_SOURCES), publication identity

## Source Generation Tracking

Each source (audio, camera, screen, screen-audio) has an independent generation counter:

1. Client sends `media-sources` with `{ source, desiredState, generation }`
2. Server validates: `clientGeneration >= currentGeneration` (or rejects `STALE_SOURCE_GENERATION`)
3. Server applies change, increments `roomRevision` and `sourceRevision` (post-commit)
4. Server responds `operation-ack` with new revisions + `connectionEpoch`

**Desired state logic**: Only audio source checks `participant.muted`. Camera/screen desired = `active` if in `participant.sources`.

## Operation Idempotency

- Client generates `operationId` via `crypto.randomUUID()`
- Server accepts client `operationId` as-is
- Server tracks operation results with 5-minute TTL
- Duplicate `operationId` → immediate `operation-ack` with cached result (idempotent replay)
- Client timeout: 5s (`MEDIA_OPERATION_ACK_TIMEOUT`)

## Revisions

- `roomRevision`, `sourceRevision`: BigInt-safe strings (not numbers)
- Compared as exact strings: `roomRevision.toString() === expectedRoomRevision`
- Post-commit: increment BEFORE sending ACK
- Participant-local ops (`media-capabilities`, `leave`) excluded from global CAS

## Heartbeat Reconciliation

Client sends `heartbeat` with:

- `sequence`: monotonically increasing
- `sourceDigest`: per-source hash of `{ generation, state, provider }`

Server:

1. Computes `localSourceDigest` from `sourceStates`
2. Compares with client `sourceDigest`
3. On mismatch: sends `state-nack` with canonical `sourceStates`
4. `state-nack` with `sequence` counts as heartbeat ACK

## Publication Identity Fencing

Publication key format: `${peerId}:${source}:${connectionEpoch}:${generation}`

Prevents stale publication replay across:

- Reconnections (new epoch)
- Source restarts (new generation)
- Provider switches

Server and client both fence publication close/start by generation.

## Error Codes

| Code                                  | Scope            | Fatal | Description                           |
| ------------------------------------- | ---------------- | ----- | ------------------------------------- |
| `MEDIA_OPERATION_ACK_TIMEOUT`         | source-operation | no    | Client ACK timeout                    |
| `DUPLICATE_OPERATION`                 | source-operation | no    | Operation ID replay detected          |
| `ROOM_REVISION_CONFLICT`              | source-operation | no    | CAS mismatch on revision              |
| `STALE_CONNECTION_EPOCH`              | source-operation | no    | Message from retired epoch            |
| `STALE_SOURCE_GENERATION`             | source-operation | no    | Client generation < server generation |
| `MEDIA_PROVIDER_UNAVAILABLE`          | provider-session | no    | No healthy provider                   |
| `MEDIA_PROVIDER_QUALIFICATION_FAILED` | provider-session | no    | Provider qualification failed         |
| `MEDIA_HANDOFF_FAILED`                | remote-consumer  | no    | Media convergence failed              |
| `AUTHENTICATION_FAILED`               | control-session  | yes   | Invalid/expired ticket                |
| `PROTOCOL_VERSION_MISMATCH`           | control-session  | yes   | Unsupported protocol version          |
| `MESSAGE_TOO_LARGE`                   | control-session  | yes   | Exceeds 96KB limit                    |

Non-fatal errors return `operation-ack` with `accepted: false` and error code. Fatal errors close WebSocket with code 4000.

## Topology Application vs Convergence

**Canonical application** (sync, fast):

- DO applies topology state, updates epoch, sourceRevision, provider
- Responds `route-commit` to all participants
- Does NOT wait for media convergence

**Media convergence** (async, independent):

- Track discovery, ICE connection, RTP flow
- Runs with `AbortSignal` fencing
- Superseded topology aborts its convergence task
- Does not block topology pipeline

## Provider Health & Fallback

- `providerHealth[providerId] = { healthy, unhealthyUntil }`
- Failure sets `unhealthyUntil = now + backoff`
- Alarm schedules recovery check (idempotent, survives hibernation)
- Fallback selects next healthy provider
- Return-to-primary when primary recovers
- Cloudflare session guarded by `sessionGeneration`

## Message Schemas

### hello919 (client → server)

```json
{
  "type": "hello919",
  "ticket": "<EdDSA JWT>",
  "peerId": "<client-generated>",
  "deviceId": "<device-id>",
  "connectionMode": "auto|direct",
  "mediaSessionId": "<session-id>",
  "protocolVersion": 919,
  "clientCapabilities": { ... }
}
```

### hi919 (server → client)

```json
{
  "type": "hi919",
  "peerId": "<server-assigned>",
  "roomRevision": "123",
  "sourceRevision": 5,
  "connectionEpoch": 1,
  "route": { "kind": "sfu", "provider": "cloudflare-realtime", "epoch": 1, "sourceRevision": 5 },
  "participants": [...],
  "publishedSources": { "audio": { "state": "active", "generation": 1, "provider": "sfu" } },
  "sourceStates": { "audio": { "generation": 1, "state": "active", "provider": "sfu" } }
}
```

### media-sources (client → server)

```json
{
  "type": "media-sources",
  "operationId": "<uuid>",
  "expectedRoomRevision": "123",
  "sources": [{ "source": "audio", "desiredState": "active", "generation": 1 }],
  "muted": false
}
```

### operation-ack (server → client)

```json
{
  "type": "operation-ack",
  "operationId": "<uuid>",
  "accepted": true,
  "roomRevision": "124",
  "sourceRevision": 6,
  "connectionEpoch": 1
}
```

### state-nack (server → client)

```json
{
  "type": "state-nack",
  "code": "STALE_SOURCE_GENERATION",
  "sequence": 42,
  "roomRevision": "124",
  "sourceRevision": 6,
  "sourceStates": {
    "audio": { "generation": 2, "state": "active", "provider": "sfu" }
  }
}
```

### heartbeat (client → server)

```json
{
  "type": "heartbeat",
  "sequence": 42,
  "sourceDigest": "sha256:abc123...",
  "connectionEpoch": 1
}
```

### provider-recovering (server → client)

```json
{
  "type": "provider-recovering",
  "retryAt": 1234567890000,
  "retryAfterMs": 5000,
  "reason": "provider-unhealthy"
}
```

## Implementation Notes

### Server (dspeak-media-control)

- `MediaRoomDO`: Durable Object owning room state
- `media-room-messages.ts`: Message handlers
- `media-room-contracts.ts`: Validation & contracts
- `media-room-topology.ts`: Topology decisions
- `media-room-provider.ts`: Provider health & tickets

### Client (dspeak2)

- `media-source-controller.ts`: Source mutations, operationId, ACK timeout
- `media-message-handlers.ts`: Server message handling
- `cloudflare-realtime-session/`: Cloudflare provider with generation/epoch
- `native-p2p-signaling.ts`: P2P signaling with epoch
- `remote-media-registry.ts`: Convergence FSM with generation/epoch
- `hybrid-media-topology-controller/controller.ts`: Topology application/convergence split

## Testing

Deterministic protocol tests in `tests/`:

- `phase1-protocol.test.js`: P0/P1 defects
- `phase6-topology-convergence.test.js`: Application/convergence split
- `phase6-source-race.test.js`: Source mutation races
- `phase6-screen-share.test.js`: Screen share matrix
- `phase6-presence-chaos.test.js`: Join/leave/rejoin chaos
- `phase6-signaling-chaos.test.js`: Provider/signaling chaos
