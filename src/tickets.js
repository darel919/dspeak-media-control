import { SignJWT, jwtVerify, importPKCS8, importSPKI } from "jose";

let mediaVerifyKeyCache = null;
let providerSigningKeyCache = null;

function base64ToPEM(base64, label) {
  if (!base64) return null;
  if (base64.includes("BEGIN")) return base64;
  const body = base64.replace(/\s+/g, "").replace(/.{64}/g, "$&\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export async function getMediaVerifyKey(env) {
  if (mediaVerifyKeyCache) return mediaVerifyKeyCache;
  const b64 = env.MEDIA_TICKET_PUBLIC_KEY;
  if (!b64) throw new Error("MEDIA_TICKET_PUBLIC_KEY not set");
  const pem = base64ToPEM(b64, "PUBLIC KEY");
  const key = await importSPKI(pem, "Ed25519");
  mediaVerifyKeyCache = key;
  return key;
}

export async function getProviderSigningKey(env) {
  if (providerSigningKeyCache) return providerSigningKeyCache;
  const b64 = env.PROVIDER_TICKET_PRIVATE_KEY;
  if (!b64) throw new Error("PROVIDER_TICKET_PRIVATE_KEY not set");
  const pem = base64ToPEM(b64, "PRIVATE KEY");
  const key = await importPKCS8(pem, "Ed25519");
  providerSigningKeyCache = key;
  return key;
}

export async function verifyMediaTicket(token, env) {
  const key = await getMediaVerifyKey(env);
  const { payload } = await jwtVerify(token, key, {
    issuer: [env.MEDIA_CONTROL_ISSUER, "dspeak-media-control"],
    audience: "dspeak-media-control",
    clockTolerance: 5,
  });
  return payload;
}

export async function signProviderTicket(claims, env) {
  const key = await getProviderSigningKey(env);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${env.PROVIDER_TICKET_TTL_SECONDS || 120}s`)
    .sign(key);
  return token;
}
