import assert from "node:assert/strict";
import test from "node:test";
import { getChannelId } from "../src/index.ts";

test("channel extraction supports the documented media-control path", () => {
  assert.equal(
    getChannelId(new URL("https://media.example/media-control/channel-42")),
    "channel-42",
  );
});

test("channel extraction preserves the existing query and room paths", () => {
  assert.equal(
    getChannelId(new URL("https://media.example/?channelId=channel-42")),
    "channel-42",
  );
  assert.equal(
    getChannelId(new URL("https://media.example/room/channel-42")),
    "channel-42",
  );
  assert.equal(
    getChannelId(new URL("https://media.example/v1/room/channel-42")),
    "channel-42",
  );
});
