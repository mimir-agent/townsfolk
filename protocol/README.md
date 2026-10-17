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
| any error | | `error-response` |

Day lifecycle: at DayEnding the bridge posts day-end (always, even with no events). The brain holds that day as pending. After the game's Saved event the bridge posts saved with the same date, and only then is the day written to each NPC's memory. If the player reloads without saving, the next day-end replaces the pending day, so an unsaved day is never remembered.
