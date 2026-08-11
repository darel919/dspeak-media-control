# dspeak-media-control

Cloudflare Worker + Durable Object media control plane for dSpeak.

## Architecture

- **Worker (Hono)**: entry point, `/healthz`, WebSocket upgrade to the channel Durable Object.
- **MediaRoomDO**: one per live media channel. Authoritative for live media membership, topology, route epochs, P2P signaling relay, provider transition state.
- **ProviderRegistryDO**: provider registry + circuit breakers + health selection.

## Deployment

```bash
npm install
npm run deploy           # wrangler deploy
wrangler secret put MEDIA_TICKET_PUBLIC_KEY
wrangler secret put PROVIDER_TICKET_PRIVATE_KEY
```

See `.env.example` for the full variable list and `wrangler.toml` for bindings.

## Key model

| Variable                         | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `MEDIA_TICKET_PUBLIC_KEY`        | Verify media tickets issued by the dSpeak server (Vercel signs). |
| `PROVIDER_TICKET_PRIVATE_KEY`    | Sign provider tickets consumed by dSpeak-SFU.                    |
| `MEDIA_CONTROL_ADMIN_TOKEN`      | Authenticate registry and Durable Object admin calls.            |
| `CLOUDFLARE_REALTIME_APP_ID`     | Cloudflare Realtime application identifier.                      |
| `CLOUDFLARE_REALTIME_APP_SECRET` | Cloudflare Realtime API credential.                              |
| `MEDIA_CONTROL_ALLOWED_ORIGINS`  | Optional browser Origin allowlist for WebSockets.                |

## Control surface

| Endpoint                        | Purpose                             |
| ------------------------------- | ----------------------------------- |
| `GET /healthz`                  | Worker liveness                     |
| `WS /media-control/:channelId`  | Upgrade to `MediaRoomDO(channelId)` |
| `POST /registry/register`       | Register a provider instance        |
| `GET /registry/health`          | Provider health + circuit breakers  |
| `POST /registry/select`         | Route selection for a room          |
| `POST /registry/report-failure` | Correlated failure reporting        |
| `POST /registry/report-success` | Reset a recovered provider breaker  |

## WebSocket/media protocol

See `src/protocol.js` for message types and route model. Protocol version is `919`.
Selected provider instance IDs are preserved in route state, topology messages,
provider tickets, and `media-qoe` aggregation. QoE selection uses worst-path
media quality rather than RTT alone, while family-only reports remain supported
for older clients.

## Development

```bash
npm run dev
```

## Repo layout

```
src/
  index.ts              Worker entry (Hono)
  protocol.js           shared protocol constants + route helpers
  tickets.js            media ticket verify + provider ticket sign
  MediaRoomDO.ts        per-channel media authority
  ProviderRegistryDO.ts provider registry + circuit breakers
tests/                   node --test suite
.env.example
wrangler.toml
```

## Related projects

- `dspeak` (Nuxt/Vercel): signs media tickets, calls `POST /api/media/bootstrap`.
- `dspeak-sfu` (self-hosted mediasoup): verifies provider tickets locally; no auth coupling.
