# Evidence

## `web/` — browser walkthrough (development preview)

Contact sheets from `npm run e2e:web`: the real app's web build, driven by Playwright against the
local development backend (real migrations, fictional seed data), with a scripted Geolocation API
and a controlled clock. Sheets 01–03 mirror the three design boards in `docs/packet/designs/` for
side-by-side comparison.

| Sheet | Shows |
|---|---|
| `01-run-loop.jpg` | Today (820 XP, 2 of 3), live run at 5.24 km / 31:28 / 6:00, summary with the server's +77 XP |
| `02-compete-progress-share.jpg` | Friday Crew standings (257 XP, 2nd), Progress (897 XP, 603 to Tempo, 39.7 %), stats-only share poster |
| `03-start-private.jpg` | Welcome, preflight ready, Privacy |
| `04-sign-in-and-recording.jpg` | Email code, permission request, countdown, early recording, paused |
| `05-after-the-run.jpg` | Today after the run; an offline finish ("saved on this phone"), the same run after reconnecting (+4 XP same-day delta), a too-short personal-only run, Progress |
| `06-new-runner-and-invites.jpg` | Onboarding, a new runner's Today, League with no crew, invite preview, joined league |
| `07-league-details.jpg` | Invite sheet, scoring rules, last week, member actions, league management |
| `08-run-detail.jpg` | Private route, splits |
| `09-profile.jpg` | Profile and its sub-screens |
| `10-export-and-deletion.jpg` | Export ready, deletion consequences, confirmation, signed out afterwards |

Regenerate: start the backend and web app as in the README, then

```bash
OUT_DIR=/tmp/shots npm run e2e:web
bash scripts/e2e/evidence-sheets.sh /tmp/shots
```

These images show flows and server integration. They are **not** evidence of GPS quality,
locked-screen recording, encryption at rest or native UI behaviour — those require the physical
device checks in [../DEVICE_TEST_PROTOCOL.md](../DEVICE_TEST_PROTOCOL.md).

## `device/` — physical iPhone runs

Not yet collected. Store each session as `device/<YYYY-MM-DD>-<device>/` following the device
protocol's log template.
