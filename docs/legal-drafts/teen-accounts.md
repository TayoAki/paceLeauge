# Teen accounts: policy and terms changes to publish when they're switched on

**Status: draft for counsel's review. Not published.** The live Privacy Policy and Terms
(`legal/`) say PaceLeague is for adults, which is true while the `teen_accounts_enabled` flag is
off. Before an operator turns the flag on (docs/OPERATIONS.md, "Age assurance"), counsel reviews
state age laws (Texas, Utah and others, docs/ROADMAP.md 4.10) and this text, and the changes below
are published in the same release. Bracketed items are for counsel or the operator to fill in.

## Privacy Policy

Replace "PaceLeague is in a beta for adults (18 and over) in the United States." with:

> PaceLeague is for adults, and for teens aged 13 to 17 in a family league run by their parent or
> guardian, in the United States.

In "What we collect", under the age check, add:

> - For teen accounts: the age band the App Store or Google Play reports (13 to 15, or 16 to 17),
>   the family leagues you ask to join, and when the adult who runs a league approved you and who
>   they are. We never receive your date of birth.

Replace the "Children" section with:

> ## Teens and children
>
> PaceLeague isn't for children under 13. We don't knowingly collect information from anyone under
> 13; where the App Store or Google Play tells us an account belongs to someone under 13, we don't
> create a profile, or we pause an existing one and remove it from its leagues, and its holder can
> still export and delete it.
>
> Teens aged 13 to 17 can have an account for their own running and join family leagues run by an
> adult, once that adult approves them as their parent or guardian. For teen accounts:
>
> - Runs are visible only to the teen, or at most to their family leagues. There are no followers,
>   feed, comments, kudos, clubs, public boards or public sharing, and no connection to Strava.
> - Their family league sees their runner name, tier and weekly XP, their season total, cheers,
>   duels, group runs and the league's challenges, like any member. The adult who runs the league
>   also sees how many times they ran this week and when they last ran, and can remove them.
> - Live location links open only for members of their family leagues who are signed in.
> - Under 16, we don't collect heart rate or other health data: no Apple Health or Health Connect
>   import or export, and no Garmin connection.
> - A parent or guardian can ask us to see, correct or delete their teen's data at [Contact email].
>
> If you believe a child under 13 has an account, contact us and we will delete it.

## Terms

Replace "You must be 18 or older and live in the United States." with:

> - You must live in the United States and be 18 or older, or 13 to 17 with the approval of the
>   parent or guardian who runs your family league.
> - If you approve a teen in your family league, you confirm you're their parent or legal guardian
>   and that they may use PaceLeague as described in the Privacy Policy. You can remove them at any
>   time.

## App Store and Google Play

- App Store Connect: update the age rating questionnaire and the Age Assurance settings for the
  Declared Age Range and Significant Change APIs [per counsel].
- Google Play: the Families policy and target audience declaration (13–17) [per counsel].
- Review notes: teen accounts join only a family league an adult approves, and can't reach
  anything outside it; the server enforces this (`tests/backend/teens.test.ts`).
