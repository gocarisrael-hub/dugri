# Occasions: what people actually order Dugri for

Gate D1 input for REDESIGN_PLAN.md. Measured 2026-10-12 from every collection on production (`GET /api/admin/collections`, read-only): 678 collections created between 2026-06-28 and 2026-10-12, paid and unpaid. Only aggregates are recorded here; no names, contacts, words or per-order rows were kept, and the raw export was deleted after counting.

## Answer in one paragraph

The owner's gut was: bachelorettes first, then parents' and grandparents' birthdays, then anniversaries. The first two are right and the third is not. **Birthdays as a whole are the largest occasion** (about 40% of everything, twice the bachelorettes), but they split by age. As single occasions, **bachelorettes lead** (23% of paid orders overall, 32% in September and October), and **birthdays of a parent or grandparent come a close second** (20% of paid orders overall, 27% in September and October). **Anniversaries are small**, about 4 to 5%. Family games (holiday or family reunion decks) come third at 7 to 8%, and retirement, farewell and army-release decks tie with anniversaries.

## Method

Each collection gets exactly one occasion, from the first of these that settles it:

1. **`event_type`**, the free-text "what is the event" field the order wizard asks for (present on 338 collections; asked on nearly every collection since mid-August).
2. **`custom_title`**, the deck title the buyer typed (invented examples of the patterns: "X's Bachelorette", "X חוגגת 60", "N שנות נישואים").
3. A title or event text whose only signal is a two-digit age (patterns like "X Turns 30" or a name followed by an age) counts as a birthday (12 collections).
4. Otherwise **unclear**. The design (theme) is NOT used: a crosstab against the collections that do state their event shows the theme does not predict the occasion. Only about 60% of the classified decks on the bachelorette design (פריז) are bachelorettes, and the anniversary design (סנטוריני) was bought for 56 birthdays against 10 anniversaries. Gender and `extra_fields` add almost nothing: AGE is filled on 3 collections and YEARS on 3.

The text rules are Hebrew and English keyword matches, applied in this order:

| Occasion                      | Matched on (examples)                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| bachelorette                  | רווקות / רווקים / רווקולדת, bachelorette, bride, wife to be, כלה, חינה, מקווה             |
| bar/bat mitzvah               | בר/בת מצווה                                                                               |
| anniversary                   | נישואין / נישואים, anniversary, years of marriage, חתונת הזהב, שנה ראשונה, חודשים של אהבה |
| wedding / engagement          | חתונה, מתחתנים, אירוסין, getting married, wedding                                         |
| birthday                      | יום הולדת / יומולדת, B-day, birthday, turns 30, חוגג/ת, בת/בן + age                       |
| retirement / farewell / army  | פרישה, פנסיה, פרידה, רילוקיישן, מעבר לחו"ל, סיום תפקיד, שחרור, מתגייס                     |
| work / team                   | צוות, גיבוש, משרד, הנהלה, אירוע חברה                                                      |
| family / holiday              | משפחה / משפחתי, ראש השנה, חג, family                                                      |
| trip / vacation               | טיול, טיסה, חופשה, נופש, vacation, trip                                                   |
| other                         | baby shower, end of a course, a surprise party with no stated reason                      |
| test / junk (excluded from %) | keyboard mash or an explicit test title in both fields                                    |

Birthday age: the AGE field when filled, else the largest one- or two-digit number in the event or title text. "Parent or grandparent" means the text names a parent, grandparent or in-law (אמא, אבא, סבא, סבתא, הורים, חמותי, and their nicknames), or the age is 60 or more.

## Results

Percentages are of all real collections in the slice (test/junk excluded, unclear included), so each column sums to 100%.

| Occasion                     | All collections | Paid orders | Paid, Sep + Oct |
| ---------------------------- | --------------: | ----------: | --------------: |
| Birthday (all ages)          |       260 (39%) |   151 (41%) |        45 (43%) |
| Bachelorette                 |       134 (20%) |    84 (23%) |        34 (32%) |
| Family / holiday game        |         57 (8%) |     24 (7%) |          8 (8%) |
| Anniversary                  |         29 (4%) |     15 (4%) |          5 (5%) |
| Retirement / farewell / army |         24 (4%) |     16 (4%) |          5 (5%) |
| Wedding / engagement         |         21 (3%) |     10 (3%) |          3 (3%) |
| Work / team                  |         14 (2%) |      7 (2%) |          2 (2%) |
| Bar/bat mitzvah              |          9 (1%) |      5 (1%) |          0 (0%) |
| Trip / vacation              |          6 (1%) |      5 (1%) |          2 (2%) |
| Other                        |          7 (1%) |      3 (1%) |          1 (1%) |
| Unclear                      |       112 (17%) |    49 (13%) |          0 (0%) |
| **Total (excl. test)**       |         **673** |     **369** |         **105** |
| Test / junk (excluded)       |               5 |           2 |               2 |

**Last 90 days.** The shop's first collection is from 2026-06-28, so the last 90 days (from 2026-07-14) contain 676 of the 678 collections and give the same table as "all" to within one row. The trend is therefore shown by month instead, on paid orders:

| Paid orders by month | August    | September | October (1–12) |
| -------------------- | --------- | --------- | -------------- |
| Paid orders          | 261       | 84        | 23             |
| Bachelorette         | 50 (19%)  | 26 (31%)  | 8 (36%)        |
| Birthday             | 104 (40%) | 37 (45%)  | 8 (36%)        |
| Anniversary          | 10 (4%)   | 3 (4%)    | 2 (9%)         |
| Unclear              | 48 (18%)  | 0         | 0              |

August still has 18% unclear (the event field was missing from most of its collections), so its bachelorette share is understated; from September, when every order states its event, bachelorettes are about a third of paid orders.

### Birthdays by age

| Birthday age band                           | All birthdays | Paid birthdays | Paid, Sep + Oct |
| ------------------------------------------- | ------------: | -------------: | --------------: |
| Child (under 18)                            |       12 (5%) |         9 (6%) |          2 (4%) |
| 18–39                                       |      47 (18%) |       21 (14%) |          3 (7%) |
| 40–59                                       |      50 (19%) |       29 (19%) |        10 (22%) |
| 60+                                         |      77 (30%) |       53 (35%) |        22 (49%) |
| No age stated                               |      74 (28%) |       39 (26%) |         8 (18%) |
| **Total**                                   |       **260** |        **151** |          **45** |
| Parent or grandparent (60+ or named as one) |           113 |             72 |              28 |
| Same, with the line at 50+                  |           137 |             84 |              31 |

Of the 60+ birthdays, about two in three also name the person as a parent or grandparent. So "parents' and grandparents' birthdays" is real: 72 of 369 paid orders (20%), 28 of 105 in September and October (27%), second only to bachelorettes.

## Caveats

- **Free text, keyword rules.** The occasion comes from what buyers typed. Some decks cover two occasions (a bachelorette that is also a round birthday); they count once, under the first matching rule (bachelorette before birthday). "Wedding / engagement" decks titled "X is getting married" are probably bachelorette decks too; counted separately, they would raise bachelorettes by up to 3 points.
- **Unclear is concentrated in August.** 112 collections (17%) have no event field and a title that is a name, a family name or a joke. Many plural family names ("The Xs", "משפחת X") look like family games, but they were left unclear rather than guessed.
- **Duplicates.** Buyers sometimes open several collections for one event. Collapsing to one per buyer and honoree leaves 559 collections with the same shape (birthday 41%, bachelorette 20%, anniversary 5%).
- **Short history.** Three and a half months, with August (a launch peak, 515 of 678 collections) dominating the totals. Re-run before relying on the September–October trend.
- **Age is inferred.** Only 3 collections carry an AGE field; the rest comes from numbers in the text. "No age stated" birthdays (28%) are not in any band.
