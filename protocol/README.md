# Protocol v1

JSON Schemas (draft 2020-12) for every message between the SMAPI bridge (`mod/`) and the brain (`brain/`). These files are the single source: `brain/src/protocol.ts` and `mod/BrainClient.cs` mirror them, and `brain/test/protocol.test.ts` checks every request and response the tests send against them.

Rules:

- Every request and every response carries `"v": 1`. A request with any other `v`, or none, gets HTTP 400. The bridge treats any non-200 as brain down and keeps vanilla behavior.
- Requests allow extra fields (a v1 minor addition must not break an older brain). Responses do not, so drift on the brain side fails the tests.

| Endpoint | Request | Response |
|---|---|---|
| `GET /v1/health` | none | `health-response` |
| `POST /v1/talk` | `talk-request` | `talk-response` |
| `POST /v1/day-end` | `day-end-request` | `day-end-response` |
| `POST /v1/saved` | `saved-request` | `saved-response` |
| `POST /v1/world` | `world-request` | `world-response` |
| `POST /v1/plan` | `plan-request` | `plan-response` |
| any error | | `error-response` |

Planning: at save load the bridge posts world (locations with sizes, the items quests may use, festival days, married NPCs). After day-end it posts plan for the day about to start. The brain asks the model once, validates every part against the world snapshot, and drops failing parts one by one; each drop is in `dropped` with a reason and in the brain log. Without a world snapshot, plan answers 409. Festival days are never planned. NPC relationship shifts in a plan are applied by the brain itself when that day is saved.

Talk consequences: every choice in a talk response carries `delta`, the friendship points the bridge adds when the player picks it (the brain clamps the model's number into -15..15; the bridge clamps again and caps talk-driven friendship at +-40 per NPC per day). A choice may carry `fact`, something the NPC will remember (a promise); the bridge reports it on that talk's day-end event, and on save it enters the NPC's memory and the town facts (told, shareable unless in confidence), so gossip can carry it. When the player talks to a happening participant at its place during its window, the response carries `happening` and exactly one choice has `join: true`; picking it makes the bridge report a `join` event whose witnesses are the other participants only, and add the join gain for each of them. The next talk requests that day send `joined: true`, so a second join is not offered.

Day lifecycle: at DayEnding the bridge posts day-end (always, even with no events). The brain holds that day as pending. After the game's Saved event the bridge posts saved with the same date, and only then is the day written to each NPC's memory. If the player reloads without saving, the next day-end replaces the pending day, so an unsaved day is never remembered.

Vanilla first: when the game's own dialogue answers a click (first meeting, an active quest for that NPC, their birthday, or a story or command-carrying line; the rule is `mod/VanillaFirst.cs`), the bridge does not call talk and reports a `chat` event with that `reason` on day-end. Memory keeps that they talked, never the game's words. Talk and plan requests carry `eventsSeen`, every event id the player has seen; the brain keeps for each NPC only the cast heart events that NPC was in (`brain/src/story.ts`), so a scene never reaches anyone who was not there.
