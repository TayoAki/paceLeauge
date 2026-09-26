# PaceLeague — Evaluation plan

## Scope and decision

Verify the specified behavior and separately validate whether users value it. This packet defines tests; it does not report app tests as completed. No AI feature is proposed, so model evaluation and AGENT_INTERFACE.md are not applicable. No autonomous tool access is part of the app.

## Success dimensions

1. Effort is saved despite offline use and interruptions.
2. GPS-derived statistics are sufficiently accurate and explain their limitations.
3. Scoring is deterministic, comprehensible, and cannot be duplicated through retries.
4. Identity, membership, route privacy, deletion, and later paid access hold across direct API calls.
5. Users can complete the core journey with native accessibility features.
6. Crews return over four weeks; later premium purchasers receive the promised value.

## Test sets

Use two physical iPhone models spanning the supported performance range and at least two supported OS versions where available. Record exact device, OS, app build, SDK matrix, network condition, battery health, and rule/validator versions. Add the full Android permission/OEM/background matrix before claiming Android support.

Prepare synthetic route fixtures for straight paths, loops, pauses, overnight runs, poor accuracy, teleport jumps, duplicate timestamps, out-of-order samples, missing chunks, long gaps, and DST week boundaries. Synthetic routes are for logic tests; actual measured outdoor routes are required for GPS quality. Use test accounts A/B, a league owner, a removed member, and a moderator. Use only disposable accounts and sandbox purchases in destructive/billing tests.

## Evaluation cases

| ID | Requirement | Positive and failure cases | Pass evidence / current state |
|---|---|---|---|
| EV-001 | REQ-001 | Each provider; cancel; expired OTP/token; cold restart; switch A→B | Device recordings + auth/access assertions; not run |
| EV-002 | REQ-002 | Fresh permission; Allow Once; denied; approximate; revoked mid-run; no fix | Observed permission state matches copy and capabilities; not run |
| EV-003 | REQ-003 | Locked screen, call, pause, force-quit, reboot, key unavailable, weak signal | Durable trace + distance/battery results against NFRs; not run |
| EV-004 | REQ-004 | Offline finish; double tap; local write failure; crash during save | One persisted summary, correct recovery, no false success; not run |
| EV-005 | REQ-005 | Duplicate/concurrent finalize; missing/conflicting chunks; token expiry; 429/5xx | One accepted run and score effect; bounded retry; not run |
| EV-006 | REQ-006 | Golden fixtures; split runs; cap; midnight; DST; deletion; changed clock | Exact expected versioned totals and corrections; not run |
| EV-007 | REQ-007 | Invite join; full/revoked invite; capacity race; remove; tie; rollover | Correct standings and denial with two real identities; not run |
| EV-008 | REQ-008 | Empty history; pagination; units; rename; delete; long title | Saved data and derived totals agree after relaunch; not run |
| EV-009 | REQ-009 | Export correct stats; share cancel; render failure; metadata inspection | No route/location/hidden metadata; native flow works; not run |
| EV-010 | REQ-010 | Cross-account route/export; stale auth; deletion partial failure; restored backup | No unauthorized disclosure; lifecycle completion evidenced; not run |
| EV-011 | REQ-011 | Filter/report/block/remove; cached/direct API bypass; moderator action | Restricted queue, visibility enforcement and audit; not run |
| EV-012 | REQ-012 | Opt-in/out; denied notifications; sign-out; timezone/DST | One intended reminder or none, no duplicates; not run |
| EV-013 | REQ-013 | Purchase/restore/pending/refund/expiry; forged and reordered event; two accounts | Current verified entitlement with correct timing; deferred V1.1 |
| EV-014 | REQ-014 | VoiceOver full journey; 200% text; reduced motion; small screen; sun | Human device review and contrast measurements; not run |
| EV-015 | REQ-015 | Redaction; environment split; monitoring failure; ranking disabled | Minimal payloads, detected incident, recording still usable; not run |

Also exercise account deletion during sync, two devices finalizing runs on the same day, leaving a league during finalize, a finalized run deleted while standings update, and a score worker retried after committing but before acknowledging. Expected outcomes come from transaction/version rules, not whichever response arrives last.

## Grading and calibration

Engineering produces reproducible traces and assertions. A second human reviewer should review consequential access/payment/data-loss evidence before release; this is a proposed review role, not a claim that an independent agent or reviewer was used here. Design/usability review records participant, task, outcome, error severity, and recovery, without fabricating quotes.

Blocking failures: lost completed run, exposed route, cross-account mutation, duplicate competitive credit, forged entitlement, irrecoverable deletion inconsistency, or an inaccessible primary action. Correctness tests require all listed critical cases to pass. Performance thresholds use measured samples and report distribution; a single successful run is insufficient. Record false-positive anomaly classifications to avoid quietly excluding legitimate runners.

The six-person prototype study targets at least five unaided completions per core task, with no severe privacy misunderstanding. This is a formative design threshold, not a statistically validated conversion prediction. Stop and redesign a confusing state even if its buttons technically function.

## Release and monitoring rules

Before external pilot: satisfy the GPS spike, critical access/scoring cases, working export/deletion, reachable support, and a real data disclosure. Before public rollout: close pilot incidents, confirm moderation ownership, complete store/account checks, and review retention results. Before Pro: premium features, purchase/restore/refund evidence, verified entitlements, and clear priced copy.

Immediately disable affected sharing/competition endpoints if private data is exposed or invalid points are awarded; keep local recording available if it is safe. Investigate any completed-run loss before expanding the cohort. Treat upload backlog lasting over 15 minutes or a repeated deletion-job failure as operational incidents with a named on-call owner. Proposed pilot report cadence: daily reliability review and weekly product review; assign real dates at kickoff.

Week-four decision: expand only when the predefined cohort metrics are encouraging and reliability/privacy gates pass. If there are too few matured users, extend measurement with a stated cap rather than declaring success or failure. If retention is weak, inspect whether recording friction, score comprehension, or absent friends caused it before adding features.

## Evidence actually obtained in this task

Current primary documentation was reviewed; three original concept boards were generated and inspected; textual rules, sample arithmetic, file structure, references, and token contrasts are checked in VALIDATION.md. No application was installed, compiled, run, or deployed. No device, user, payment, or production security result exists yet.
