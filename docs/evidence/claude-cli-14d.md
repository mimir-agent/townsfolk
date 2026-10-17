# Real-model run: 14 days through the claude CLI

Run once on the Mac mini, 2026-10-17, from branch feat/slice5-year-sim:

    cd brain
    npm run sim -- --adapter claude-cli --days 14 --seed 1 --out ../docs/evidence/diary-claude-cli-14d.md --verbose

Model: the `claude -p` CLI (Claude Code 2.1.295), model alias `haiku`, its own login. No key or token was read, stored or printed.

The full diary is `diary-claude-cli-14d.md` next to this file.

## Numbers

- Wall time: 691.7 s (11 min 32 s) for 14 days.
- Model calls: 115 (15 plans, the rest talk turns). Talk turns took about 2 to 6 s; plans grew from 8 s on day 1 to about 33 s by day 14 as the prompt filled up.
- Plans: 13 from the model, 1 festival day (spring 13, never planned), 0 fallbacks.
- Plan parts dropped by the validator: 5 in 14 nights (a happening with fewer than 2 participants scheduled there, 3 times; one schedule starting at 600, before the 610 limit, which also cost that happening a participant).
- Schedule regens: 0. The model never repeated a schedule from the last 7 nights.

## Checks (all PASS)

- Memory files at most 32 KB every day: largest 7350 bytes.
- Canary never leaves Emily: no prompt, memory file or fact outside Emily carried it.
- No identical planned schedule on more than 3 consecutive planned days: longest identical run 1.
- Goals: 8 started (one per cast member), none finished yet. The 8-goal check is only enforced for runs of 112 days or more.
- Every applied plan part passes the validator again.

## What this shows and what it does not

This is evidence that the real model stays valid and does not repeat schedules over two weeks. It is not proof that it stays fresh for a year: 14 days is one run, one seed, one model.

One thing it does show that needs attention: happenings repeat in theme. Of the 5 happenings that survived validation, 4 were Egg Festival preparation with Lewis and Robin. Schedules vary, but the happening prompt pulls toward the next festival. Worth a look before a long real run (a season), for example by putting recent happenings more strongly in the digest. Not changed in this slice.
