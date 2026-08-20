# Media tickets — dspeak-media-control (Cloudflare Worker/DO)

This project sits in the middle of the ticket chain: it **verifies** media
tickets (signed by dspeak) and **signs** provider tickets (verified by
dspeak-sfu). It holds the private half of exactly one keypair and the public
half of exactly one keypair.

## Two keypairs, two trust directions

### Keypair 1 — media tickets (dspeak → this worker)

One Ed25519 keypair, split across two deployments:

- `dspeak` (Vercel) holds `MEDIA_TICKET_PRIVATE_KEY` → **signs**
- this worker holds `MEDIA_TICKET_PUBLIC_KEY` → **verifies**

```
openssl genpkey -algorithm Ed25519 -out media-ticket-private.pem
openssl pkey -in media-ticket-private.pem -pubout -out media-ticket-public.pem
```

| Env (where)                           | Value                                |
| ------------------------------------- | ------------------------------------ |
| `MEDIA_TICKET_PRIVATE_KEY` (dspeak)   | `base64 -i media-ticket-private.pem` |
| `MEDIA_TICKET_PUBLIC_KEY` (this repo) | `base64 -i media-ticket-public.pem`  |

`verifyMediaTicket()` (in `src/tickets.ts`) requires the JWT to have
`iss: MEDIA_CONTROL_ISSUER` and `aud: "dspeak-media-control"`.

### Keypair 2 — provider tickets (this worker → dspeak-sfu)

A **separate** Ed25519 keypair, generated and owned entirely here:

```
openssl genpkey -algorithm Ed25519 -out provider-ticket-private.pem
openssl pkey -in provider-ticket-private.pem -pubout -out provider-ticket-public.pem
```

| Env (where)                                   | Value                                   |
| --------------------------------------------- | --------------------------------------- |
| `PROVIDER_TICKET_PRIVATE_KEY` (this repo)     | `base64 -i provider-ticket-private.pem` |
| `DSPEAK_MEDIA_TICKET_PUBLIC_KEY` (dspeak-sfu) | `base64 -i provider-ticket-public.pem`  |

Note: the env var name on the dspeak-sfu side is
`DSPEAK_MEDIA_TICKET_PUBLIC_KEY`, but it holds the **provider-ticket** public
key — not the media-ticket public key. Legacy naming; the comment in
`dspeak-sfu/.env.example` explains it.

## Env reference

| Var                              | Required                  | Used by      | Purpose                                         |
| -------------------------------- | ------------------------- | ------------ | ----------------------------------------------- |
| `MEDIA_TICKET_PUBLIC_KEY`        | yes                       | `tickets.ts` | verify media tickets from dspeak                |
| `PROVIDER_TICKET_PRIVATE_KEY`    | yes                       | `tickets.ts` | sign provider tickets for dspeak-sfu            |
| `MEDIA_CONTROL_ADMIN_TOKEN`      | yes                       | registry/DO  | authenticate provider and admin calls           |
| `CLOUDFLARE_REALTIME_APP_SECRET` | yes for Cloudflare routes | MediaRoomDO  | call Cloudflare Realtime APIs                   |
| `CLOUDFLARE_REALTIME_APP_ID`     | yes for Cloudflare routes | MediaRoomDO  | identify the Realtime application               |
| `MEDIA_CONTROL_ISSUER`           | no                        | `tickets.ts` | expected issuer; default `dspeak-media-control` |
| `PROVIDER_TICKET_TTL_SECONDS`    | no                        | `tickets.ts` | provider ticket TTL; default 120                |

Everything else that used to be listed (Supabase, R2, `MEDIA_CONTROL_DOMAIN`,
`PROTOCOL_VERSION`, `MEDIA_TICKET_TTL_SECONDS`, `PROVIDER_TICKET_PUBLIC_KEY`)
is **not read anywhere in code** — do not set them.

## Local dev

```bash
cp .env.example .env   # fill in the two keys
npx wrangler login
npm run dev            # http://localhost:8787
curl http://localhost:8787/healthz   # {"status":"ok"}
```

## Deploy

```bash
wrangler secret put MEDIA_TICKET_PUBLIC_KEY
wrangler secret put PROVIDER_TICKET_PRIVATE_KEY
npm run deploy
```

## Related

- `dspeak/docs/media-tickets.md` — signer side (dspeak)
- `dspeak-sfu/docs/media-tickets.md` — provider-ticket verifier (dspeak-sfu)
