# dspeak-media-control

Cloudflare Worker + Durable Object media control plane for dSpeak.

## What this is

Runs on Cloudflare Workers. One Worker entrypoint + two Durable Objects:

- **MediaRoomDO** — one per live media channel. Owns topology, route epochs, P2P signaling relay, provider transitions.
- **ProviderRegistryDO** — provider registry + circuit breakers + route selection.
- **Worker (Hono)** — HTTP endpoints, WebSocket upgrade to the per-channel DO.

The main dSpeak app (`dspeak`) calls `POST /api/media/bootstrap` on its own
server, which signs a short-lived media ticket and returns the WebSocket URL.
This Worker/DO verifies that ticket and admits the client to the channel control
plane. The DO mints provider tickets only for the standalone `dspeak-sfu` route;
Cloudflare Realtime requests stay inside the DO.

## Architecture / flow

```
[Client] --WS /media-control/:channelId + signed ticket--> [Worker] --upgrade--> [MediaRoomDO(channelId)]
[dspeak app] --POST /api/media/bootstrap--> (signs media ticket with its own private key)

MediaRoomDO            ProviderRegistryDO
  ├─ verify media ticket (Ed25519 public key)
  ├─ route selection via ProviderRegistryDO
  ├─ commit route epoch, broadcast topology
  └─ mint provider tickets for dspeak-sfu (own private key)
```

## Prerequisites

- Node.js >= 22
- Cloudflare account, logged in via `wrangler login`
- The two Durable Object classes are registered in `wrangler.toml` (already done)

## Configure

1. Generate the two Ed25519 keypairs (see below).
2. Set variables/secrets.
3. Deploy.

### Key generation

```bash
# 1. Media ticket keypair — main app (Vercel) keeps PRIVATE, this worker gets PUBLIC
openssl genpkey -algorithm Ed25519 -out media-ticket-private.pem
openssl pkey -in media-ticket-private.pem -pubout -out media-ticket-public.pem
base64 -i media-ticket-public.pem       # -> MEDIA_TICKET_PUBLIC_KEY
# put media-ticket-private.pem on the dspeak (Vercel) side, never here

# 2. Provider ticket keypair — this worker signs, dspeak-sfu verifies
openssl genpkey -algorithm Ed25519 -out provider-ticket-private.pem
openssl pkey -in provider-ticket-private.pem -pubout -out provider-ticket-public.pem
base64 -i provider-ticket-public.pem    # -> share with dspeak-sfu
```

> `base64 -i` is macOS syntax (`-w 0` is GNU). The `.env.example` shows the
> same values; `tickets.js` strips whitespace either way.

### Environment variables

All vars can live in `wrangler.toml` (`[vars]`) or as secrets. Secrets never
go in the file — set them with `wrangler secret put`:

| Variable                         | Type   | Purpose                                                          |
| -------------------------------- | ------ | ---------------------------------------------------------------- |
| `MEDIA_TICKET_PUBLIC_KEY`        | secret | Ed25519 public key used to verify media tickets signed by dspeak |
| `PROVIDER_TICKET_PRIVATE_KEY`    | secret | Ed25519 private key used to sign provider tickets for dspeak-sfu |
| `MEDIA_CONTROL_ADMIN_TOKEN`      | secret | Authenticate registry and Durable Object admin calls             |
| `CLOUDFLARE_REALTIME_APP_SECRET` | secret | Cloudflare Realtime API credential for Cloudflare SFU routes     |
| `CLOUDFLARE_REALTIME_APP_ID`     | var    | Cloudflare Realtime application identifier                       |
| `DSPEAK_SFU_ENABLED`             | var    | Set to `true` only when a self-hosted mediasoup SFU is deployed  |
| `DSPEAK_SFU_SIGNALING_URL`       | var    | `ws:`/`wss:` signaling URL for the enabled self-hosted SFU       |
| `MEDIA_CONTROL_ALLOWED_ORIGINS`  | var    | Optional comma-separated browser Origin allowlist                |
| `MEDIA_CONTROL_ISSUER`           | var    | issuer claim, default `dspeak-media-control`                     |
| `PROVIDER_TICKET_TTL_SECONDS`    | var    | provider ticket lifetime, `120`                                  |
| `MEDIA_CONTROL_DEBUG`            | var    | Set to `true` for redacted control-plane debug events            |

For local dev, create a `.dev.vars` file (gitignored) with the same keys:

```bash
cp .env.example .dev.vars
# edit .dev.vars with real values
```

### Wrangler secrets

```bash
wrangler secret put MEDIA_TICKET_PUBLIC_KEY
wrangler secret put PROVIDER_TICKET_PRIVATE_KEY
wrangler secret put MEDIA_CONTROL_ADMIN_TOKEN
wrangler secret put CLOUDFLARE_REALTIME_APP_SECRET
```

## Run locally

```bash
npm install
npm run dev        # wrangler dev — starts at http://localhost:8787
```

If you only have the public key but no private key locally, the worker still
boots but media ticket verification will fail until `MEDIA_TICKET_PUBLIC_KEY`
is set — that's expected.

Self-hosted mediasoup is optional. Keep `DSPEAK_SFU_ENABLED=false` and leave
`DSPEAK_SFU_SIGNALING_URL` empty when no `dspeak-sfu` instance is deployed.
With that configuration the registry returns no self-hosted route and skips
provider health probes and retry alarms. Set both values only after the SFU is
reachable at the configured WebSocket URL. Cloudflare Realtime remains the
control-plane provider when its credentials are configured.

## Deploy

```bash
npm run deploy     # wrangler deploy
```

After deploying, set secrets again (each environment needs them):

```bash
wrangler secret put MEDIA_TICKET_PUBLIC_KEY --env production
# etc.
warning: wrangler secret put with --env requires `wrangler.toml` env config
```

## Endpoints / protocol

| Endpoint                        | Purpose                              |
| ------------------------------- | ------------------------------------ |
| `GET /healthz`                  | Worker liveness                      |
| `WS /media-control/:channelId`  | Upgrade to `MediaRoomDO(channelId)`  |
| `POST /registry/register`       | Register a provider (admin only)     |
| `POST /registry/select`         | Select a route (internal/admin only) |
| `GET /registry/health`          | Inspect providers (admin only)       |
| `POST /registry/report-failure` | Report a provider failure            |
| `POST /registry/report-success` | Reset a recovered provider breaker   |

### WebSocket protocol

Client connects to `WS /media-control/:channelId` and must send a valid media
ticket first (see `src/protocol.js` for message constants / route model).

Protocol version: **919** — hello handshake family (`hello919`, `hi919`), same
as the media signaling protocol in the main app. Contract revision: **3**;
SFU readiness and failure acknowledgements echo the selected provider instance
when one is assigned.

The mediasoup fallback is available only when a healthy `dspeak-sfu` instance
is registered at `/registry/register`. Registration accepts `provider`,
`region`, and numeric `priority`; selection returns the concrete provider
instance after health, circuit, region, and priority checks. Cloudflare
Realtime does not use a provider ticket; its credentials remain Worker
secrets.

`media-qoe` reports accept an optional concrete `providerId` alongside the
provider family and path metrics. A participant may report several provider
instances at once; measurements older than 30 seconds are excluded from route
placement. The wire fields `rttMs`, `jitterMs`, and `jitterBufferDelayMs` are
always milliseconds, while `packetLossPercent` is always a percentage. The
legacy aliases `rtt`, `jitter`, and `jitterBufferDelay` are interpreted as
seconds for compatibility. The room keeps instances separate and sends
complete candidates to the registry. Selection uses a conservative worst-path
QoE score that accounts for RTT, jitter, jitter-buffer delay, and packet loss;
family-only reports remain supported for older clients.

For a route with a concrete `providerId`, `provider-ready`, `topology-ready`,
`provider-failure`, and `topology-failed` messages must echo the selected
provider family, instance ID, epoch, and source revision. Mismatched route
identities are ignored as stale messages.

## Tests

```bash
npm run test        # node --test
npm run format      # prettier --write
npm run format:check
```

## Repo layout

```
src/
  index.ts              Worker entry (Hono)
  protocol.js           shared protocol constants + route helpers
  tickets.js            media ticket verify + provider ticket sign
  MediaRoomDO.ts        per-channel media authority
  ProviderRegistryDO.ts provider registry + circuit breakers
tests/                  node --test suite
wrangler.toml           bindings + var defaults
.env.example            variable reference
docs/architecture.md    extended architecture notes
```

## Related projects

- `dspeak` (Nuxt/Vercel): signs media tickets, calls `POST /api/media/bootstrap`.
- `dspeak-sfu` (self-hosted mediasoup): verifies provider tickets locally; no auth coupling.
