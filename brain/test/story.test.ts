// NPCs know the game's own scenes they were in, and nobody else's. Ids come from the bridge
// (Game1.player.eventsSeen, unfiltered); story.ts picks each NPC's own.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CAST } from "../src/cast.ts";
import { DEFAULT_FAKE_REPLY, fakeAdapter } from "../src/model.ts";
import { STORY, storyFor } from "../src/story.ts";
import { WORLD, planReq, reply, spring } from "./plan-fixtures.ts";
import { talkReq, withServer } from "./helpers.ts";

const SHANE_CLIFFS = "3910975";
const ABIGAIL_FLUTE = "2";
const EMILY_CLOTHING_THERAPY = "2123243";

test("storyFor keeps only the scenes this NPC was in", () => {
  // Shane's cliffs, Abigail's flute, and an id that is nobody's heart event.
  const seen = [SHANE_CLIFFS, ABIGAIL_FLUTE, "60367"];
  assert.deepEqual(storyFor("Shane", seen), [STORY.find((e) => e.ids.includes(SHANE_CLIFFS))!.views.Shane]);
  assert.deepEqual(storyFor("Abigail", seen), [STORY.find((e) => e.ids.includes(ABIGAIL_FLUTE))!.views.Abigail]);
  for (const npc of CAST.filter((n) => n !== "Shane" && n !== "Abigail")) assert.deepEqual(storyFor(npc, seen), [], npc);
  // Someone outside the cast knows none of these.
  assert.deepEqual(storyFor("Marnie", seen), []);
  assert.deepEqual(storyFor("Shane", []), []);
});

test("a scene with several cast members present is known to each of them, in their own words, and to no one else", () => {
  const seen = [EMILY_CLOTHING_THERAPY];
  const present = ["Emily", "Lewis", "Abigail", "Shane", "Robin"];
  const lines = new Set<string>();
  for (const npc of CAST) {
    const got = storyFor(npc, seen);
    if (present.includes(npc)) {
      assert.equal(got.length, 1, npc);
      lines.add(got[0]!);
    } else assert.deepEqual(got, [], npc);
  }
  assert.equal(lines.size, present.length, "each one remembers it from their own side");
});

test("a scene listed under two ids counts once", () => {
  assert.equal(storyFor("Abigail", ["195012", "195019"]).length, 1);
});

test("story table: ids are unique, every view belongs to a cast member, and no line names the player by a game token", () => {
  const ids = STORY.flatMap((e) => e.ids);
  assert.equal(new Set(ids).size, ids.length, "an id appears in one scene only");
  for (const e of STORY) {
    for (const [npc, line] of Object.entries(e.views)) {
      assert.ok((CAST as readonly string[]).includes(npc), `${npc} in ${e.ids}`);
      assert.ok(line.length > 0 && line.length <= 200, `${e.ids} ${npc} length`);
      assert.doesNotMatch(line, /[$#@%^{}<>|]/, `${e.ids} ${npc} has a game dialogue command character`);
    }
  }
});

test("knowledge boundary over HTTP: Shane's talk prompt has his cliff scene; Abigail's, with the same ids sent, does not", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await withServer(model, async (c) => {
    const cliffs = /by the cliffs/;
    const eventsSeen = [SHANE_CLIFFS, "611944"];
    assert.equal((await c.post("/v1/talk", talkReq({ npc: "Shane", eventsSeen }))).status, 200);
    assert.match(model.calls.at(-1)!.user, cliffs);
    assert.match(model.calls.at(-1)!.user, /Moments Shane shared with the farmer/);
    for (const npc of CAST.filter((n) => n !== "Shane")) {
      assert.equal((await c.post("/v1/talk", talkReq({ npc, eventsSeen }))).status, 200);
      assert.doesNotMatch(model.calls.at(-1)!.user, cliffs, npc);
      assert.doesNotMatch(model.calls.at(-1)!.user, /Moments .* shared with the farmer/, npc);
    }
  });
});

test("knowledge boundary in the plan prompt: the cliff scene is in Shane's block only", async () => {
  const model = fakeAdapter([reply()]);
  await withServer(model, async (c) => {
    assert.equal((await c.post("/v1/world", WORLD)).status, 200);
    assert.equal((await c.post("/v1/plan", { ...planReq(spring(6)), eventsSeen: [SHANE_CLIFFS] })).status, 200);
    const prompt = model.calls[0]!.user;
    const blocks = Object.fromEntries(prompt.split(/^## /m).slice(1).map((b) => [b.split("\n")[0]!, b]));
    assert.match(blocks.Shane!, /by the cliffs/);
    for (const npc of CAST.filter((n) => n !== "Shane")) assert.doesNotMatch(blocks[npc]!, /by the cliffs/, npc);
  });
});

test("eventsSeen with an id outside the allowed characters is refused", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    const res = await c.postRaw("/v1/talk", talkReq({ eventsSeen: ["3910975/../x"] }));
    assert.equal(res.status, 400);
    assert.match(res.json.error, /eventsSeen\[0\]/);
  });
});
