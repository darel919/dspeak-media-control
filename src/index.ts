import { Hono } from "hono";
import { MediaRoomDO } from "./MediaRoomDO.ts";
import { ProviderRegistryDO } from "./ProviderRegistryDO.ts";

type WorkerBindings = {
  MEDIA_ROOM_DO: DurableObjectNamespace;
  PROVIDER_REGISTRY_DO: DurableObjectNamespace;
};

const app = new Hono<{ Bindings: WorkerBindings }>();

app.get("/healthz", (c) => c.json({ status: "ok" }));

app.all("*", async (c) => {
  const requestUrl = new URL(c.req.url);

  if (requestUrl.pathname === "/healthz") {
    return c.json({ status: "ok" });
  }

  if (requestUrl.pathname.startsWith("/registry/")) {
    const registryId = c.env.PROVIDER_REGISTRY_DO.idFromName("global");
    const registry = c.env.PROVIDER_REGISTRY_DO.get(registryId);
    const registryUrl = new URL(requestUrl);
    registryUrl.pathname = registryUrl.pathname.replace(/^\/registry/, "");
    return registry.fetch(new Request(registryUrl, c.req.raw));
  }

  const channelId = getChannelId(requestUrl);

  if (!channelId) {
    return c.json({ error: "channelId is required" }, 400);
  }

  const roomId = c.env.MEDIA_ROOM_DO.idFromName(channelId);
  const room = c.env.MEDIA_ROOM_DO.get(roomId);
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-dSpeak-Channel-Id", channelId);
  return room.fetch(new Request(c.req.raw, { headers }));
});

function getChannelId(url: URL) {
  const queryChannelId = url.searchParams.get("channelId");
  if (queryChannelId) return normalizeChannelId(queryChannelId);

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "media-control" && segments[1])
    return normalizeChannelId(segments[1]);
  if (segments[0] === "room" && segments[1])
    return normalizeChannelId(segments[1]);
  if (segments[0] === "v1" && segments[1] === "room" && segments[2])
    return normalizeChannelId(segments[2]);
  return null;
}

function normalizeChannelId(value: string) {
  try {
    const channelId = decodeURIComponent(value).trim();
    if (!channelId || channelId.length > 128 || channelId.includes("/"))
      return null;
    return channelId;
  } catch {
    return null;
  }
}

export default app;

export { MediaRoomDO, ProviderRegistryDO, getChannelId };
