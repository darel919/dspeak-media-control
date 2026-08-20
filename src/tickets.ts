import {
  SignJWT,
  importPKCS8,
  importSPKI,
  jwtVerify,
  type JWTPayload,
  type KeyLike,
} from "jose";

export interface TicketEnvironment {
  MEDIA_TICKET_PUBLIC_KEY?: string;
  PROVIDER_TICKET_PRIVATE_KEY?: string;
  MEDIA_CONTROL_ISSUER?: string;
  PROVIDER_TICKET_TTL_SECONDS?: string | number;
}

let mediaVerifyKeyCache: KeyLike | null = null;
let providerSigningKeyCache: KeyLike | null = null;

function base64ToPEM(
  base64: string | null | undefined,
  label: string,
): string | null {
  if (!base64) return null;
  if (base64.includes("BEGIN")) return base64;
  const normalized = base64.replace(/\s+/g, "");
  try {
    const decoded = atob(normalized);
    if (decoded.includes("BEGIN")) return decoded;
  } catch {}
  const body = normalized.replace(/.{64}/g, "$&\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export async function getMediaVerifyKey(
  env: TicketEnvironment,
): Promise<KeyLike> {
  if (mediaVerifyKeyCache) return mediaVerifyKeyCache;
  const b64 = env.MEDIA_TICKET_PUBLIC_KEY;
  if (!b64) throw new Error("MEDIA_TICKET_PUBLIC_KEY not set");
  const pem = base64ToPEM(b64, "PUBLIC KEY");
  if (!pem) throw new Error("MEDIA_TICKET_PUBLIC_KEY is invalid");
  const key = await importSPKI(pem, "Ed25519");
  mediaVerifyKeyCache = key;
  return key;
}

export async function getProviderSigningKey(
  env: TicketEnvironment,
): Promise<KeyLike> {
  if (providerSigningKeyCache) return providerSigningKeyCache;
  const b64 = env.PROVIDER_TICKET_PRIVATE_KEY;
  if (!b64) throw new Error("PROVIDER_TICKET_PRIVATE_KEY not set");
  const pem = base64ToPEM(b64, "PRIVATE KEY");
  if (!pem) throw new Error("PROVIDER_TICKET_PRIVATE_KEY is invalid");
  const key = await importPKCS8(pem, "Ed25519");
  providerSigningKeyCache = key;
  return key;
}

export async function verifyMediaTicket(
  token: string,
  env: TicketEnvironment,
): Promise<JWTPayload> {
  const key = await getMediaVerifyKey(env);
  const issuer = String(env.MEDIA_CONTROL_ISSUER || "dspeak-media-control");
  const { payload } = await jwtVerify(token, key, {
    issuer,
    audience: "dspeak-media-control",
    clockTolerance: 5,
    requiredClaims: ["exp", "sub", "deviceId", "channelId"],
  });
  return payload;
}

export async function signProviderTicket(
  claims: Record<string, unknown>,
  env: TicketEnvironment,
): Promise<string> {
  const key = await getProviderSigningKey(env);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${env.PROVIDER_TICKET_TTL_SECONDS || 120}s`)
    .sign(key);
  return token;
}
