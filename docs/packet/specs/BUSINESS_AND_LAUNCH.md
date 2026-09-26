# PaceLeague — Business, cost, and launch plan

## Audience and positioning to test

Start with small adult recreational running crews that already know each other. The buyer/user is the runner; the initial organizer is a crew member who can invite five friends. Proposed message: **“A running league for showing up.”** Supporting promise: record your runs, build a permanent rank, and compare your best three days with your crew. This positioning is a hypothesis; no competitive-superiority or health-benefit claim has been established.

Recruitment candidates are local crews and existing friend groups, with explicit participant consent. Prepare a short demonstration of one saved run and a real group scoreboard. Do not imply an official relationship with Runify or use its brand, screenshots, names of tiers, or marketing metrics as PaceLeague proof.

## Packaging

| Plan | Proposed value | Timing |
|---|---|---|
| Free | Recorder, complete personal history, permanent tiers, one private 20-person league, weekly standings, standard stats share, privacy/export/deletion | Pilot and public V1 |
| Pro | Implemented advanced personal comparisons and premium share-card styles | V1.1 only if evidence supports it |

Annual **USD 29.99** is a starting price hypothesis for the US paid experiment, not a configured store product or a recommendation proven by research. Start with one clear annual offer and no free trial for the initial price test; let users experience the free core first. Reassess the offer if the premium value is too slight to justify purchase. Store-localized price/period and renewal/cancellation terms must appear before confirmation. Do not charge for rank advantages, route privacy, or account export.

## Proof-of-pay test card

**Prerequisites:** retained free users, working premium features, approved store setup, purchase restoration, refund/revocation handling, and support. No experiment was run in this task.

- Hypothesis: some users who have already saved three runs will pay for deeper reflection and personalized sharing.
- Eligible population: adult pilot/public users in the selected storefront with three accepted runs, no prior Pro subscription, and a compatible app build. Staff/test accounts excluded.
- Exposure: present the offer from an intentional “See Pro” entry after value, never during recording/saving. Track unique eligible offer viewers as well as eligible users who never open it.
- Window: four weeks after launch of working Pro, or 200 eligible unique offer viewers, whichever comes later, with a founder-approved stop date. Do not treat insufficient exposure as rejection of the idea.
- Budget hypothesis: up to USD 300 for acquisition only if the founder later approves the experiment. No budget is authorized or spent by this packet.
- Evidence: verified purchase IDs mapped to cohort, net proceeds, refunds, use of premium features, acquisition spend, and support time. An opened paywall or claimed intent is not a purchase.
- Initial decision: ten independent verified purchases among 200 viewers would be a directional signal worth investigating, not proof of scale. Continue only if contribution is positive and buyers use the promised features; revise the offer if purchase/refund interviews indicate weak value. Stop expansion for access errors or misleading billing.
- Next test: if the single offer works, compare pricing or packaging with comparable cohorts. Sequential price changes are confounded by acquisition mix and timing; do not claim controlled evidence from them.

## Economics worksheet

Use actual provider/store proceeds, not a blanket fee percentage. Track gross billings, taxes/fees, refunds, net proceeds, variable service costs, and support reserve separately.

`contribution before acquisition = net proceeds - variable delivery cost - support reserve`

`observed CAC = attributable acquisition spend / attributable first-time purchasers`

No purchasers means CAC is undefined, not zero. Lifetime value remains an assumption until renewals are observed; annual billings are not all monthly recurring revenue. Do not sell lifetime access before estimating ongoing obligations.

Illustrative arithmetic only: if a USD 29.99 annual purchase eventually yields USD 24 of net proceeds and requires USD 6 of delivery/support, contribution before acquisition is USD 18. A USD 12 CAC target would leave USD 6 toward overhead/profit. Replace every assumption with matched-cohort data; these are not quoted store fees or measured margins.

## Build budget model

Use the PLAN.md estimate of 680–1,000 total hours for the scoped iOS V1 and pilot. Example contract-rate scenarios, **not surveyed market rates**:

| Assumed blended hourly rate | Base labor calculation | With 20% contingency |
|---|---:|---:|
| USD 50 | USD 34,000–50,000 | USD 40,800–60,000 |
| USD 100 | USD 68,000–100,000 | USD 81,600–120,000 |
| USD 150 | USD 102,000–150,000 | USD 122,400–180,000 |

Pro, Android, integrations, ongoing moderation, paid acquisition, legal review, taxes, and founder time are not included unless contracted into those hours. Ask for milestone pricing after the GPS spike, not an unqualified fixed price for “a Runify clone.”

Initial operational reserve hypothesis: USD 100–300/month for a small pilot, excluding labor and marketing. This is not a vendor quote or minimum. Verify current backend, build, storage/egress, email, maps, crash-monitoring and purchase-service plans before buying. Developer program enrollment and test hardware are separate line items. Do not assume a free tier is suitable for the final data or uptime needs.

Capacity example: 1,000 monthly active runners × 12 runs/month × assumed 0.3 MB compressed route payload ≈ 3.6 GB of new route data/month before replicas/backups and overhead. The 0.3 MB value is a planning input to replace with F01 measurements. Read traffic, repeated uploads, retention, function time and support can matter more than storage alone.

## Launch preparation

Use current primary store guidance at submission, not the date of this document. Apple guidance covers user-generated content controls and review details [S05]; deletion guidance covers the account lifecycle [S06]. Android expansion adds its own background-location and deletion requirements [S10, S14]. The planned native store-purchase route is a simplifying choice; purchase rules vary by storefront and product and must be rechecked.

| Area | Concrete deliverable before launch | Current state |
|---|---|---|
| Identity | Cleared name, real operator, developer organization, support address | Not supplied |
| Privacy | Accurate inventory of GPS, account, activity, billing, diagnostics, providers, retention and deletion | Architecture proposed; configuration unverified |
| Store privacy | Disclosures reconciled to actual SDKs/traffic and third parties | Not prepared from a real build |
| Terms | Rules, eligibility, no-cash competition, billing if any, conduct and dispute/support handling | Owner-specific draft required |
| Support | Reachable page/email, report/deletion workflow, ownership and response targets | Workflow specified, no live destination |
| Review access | Working reviewer account or approved demo mode; permission explanation; real app screenshots | No build yet |
| Safety/conduct | Report/block/filter, moderator queue, member removal, no pressure to run through pain | Requirements prepared |
| Device quality | Recorder, privacy, accessibility and lifecycle evidence | Not run |
| Billing | Actual premium features, localized offer, restore/manage links, entitlement tests | V1.1 deferred |
| Release operations | Build/environment ownership, redacted monitoring, incident runbook, ranking kill switch | Planned |

Keep legal/support copy factual to the actual app; do not publish generated policies with invented operator details or unverified retention promises. Generated concept boards are for planning, not App Store screenshots. Use real tested application screens for store claims.

## Operating cadence

During the pilot, review lost-run reports, sync backlog, invalid-score rate, battery/GPS complaints, privacy reports and deletion failures daily. Review cohort activation, crew participation and week-four return weekly. Route privacy/access incidents take priority over growth. Assign a named owner before inviting external users. Use findings to change one part of the loop at a time; preserve rule versions so participants understand score changes.

## Next founder choices

1. Confirm that the intended reference is the ranked GPS Runify and that small private crews are the first audience.
2. Confirm iPhone first and whether carrying a phone is acceptable, or whether watch import must change the MVP.
3. Set an available budget/team and decide whether to commission the bounded GPS milestone.

These choices improve the next stage; they were not required to complete this planning packet.

## Source links

[S05]: https://developer.apple.com/app-store/review/guidelines/
[S06]: https://developer.apple.com/support/offering-account-deletion-in-your-app/
[S10]: https://developer.android.com/develop/sensors-and-location/location/background
[S14]: https://support.google.com/googleplay/android-developer/answer/13327111

[Full source register](../SOURCES.md).
