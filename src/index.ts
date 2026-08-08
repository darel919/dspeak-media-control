import { Hono } from "hono";
import { MediaRoomDO } from "./MediaRoomDO.ts";
import { ProviderRegistryDO } from "./ProviderRegistryDO.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ status: "ok" }));

export default app;

export { MediaRoomDO, ProviderRegistryDO };
