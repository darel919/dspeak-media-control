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

| Variable                      | Purpose                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `MEDIA_TICKET_PUBLIC_KEY`     | Verify media tickets issued by the dSpeak server (Vercel signs). |
| `PROVIDER_TICKET_PRIVATE_KEY` | Sign provider tickets consumed by dSpeak-SFU.                    |
| `PROVIDER_TICKET_PUBLIC_KEY`  | Matching public key, shared with dSpeak-SFU.                     |

## Control surface

| Endpoint                                 | Purpose                             |
| ---------------------------------------- | ----------------------------------- |
| `GET /healthz`                           | Worker liveness                     |
| `WS /media-control/:channelId`           | Upgrade to `MediaRoomDO(channelId)` |
| `POST /provider-registry/register`       | Register a provider instance        |
| `GET /provider-registry/health`          | Provider health + circuit breakers  |
| `POST /provider-registry/select`         | Route selection for a room          |
| `POST /provider-registry/report-failure` | Correlated failure reporting        |

## WebSocket/media protocol

See `src/protocol.js` for message types and route model. Protocol version is `2`.

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
