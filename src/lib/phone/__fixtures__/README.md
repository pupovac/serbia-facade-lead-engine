# Phone extraction fixtures

## `portal-srbija-termo-izolacija.html`

The thermal- and sound-insulation category page of `portal-srbija.com`, saved
verbatim on 2026-08-20 from
`https://www.portal-srbija.com/termo-izolacija-zvucna-izolacija`.

Fetched once, by hand, with an honest user agent, from a page that
`https://www.portal-srbija.com/robots.txt` allows (`Allow: /`, with only
`/admin*/` and `/pretraga/` disallowed). It is a public business directory
listing published by the businesses themselves for business contact — the same
basis the crawler works on. Nothing behind a login, no CAPTCHA, no second
request.

It is here because it is genuinely messy in the ways that break a phone
extractor: 100 `tel:` links of which 97 are distinct, numbers written both as
`011 7559441` and `0117559441`, house numbers sitting directly in front of a
phone (`Vojvode Stepe 80-82 018 550907`, `Bulevar oslobođenja 351 011 4065142`),
a founding date, a price and an opening-hours range that all look like numbers.

**Counted by hand before the expectations in `fixture.test.ts` were written:**

|                                                 |                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Distinct runs of digits a reader can see        | 101                                                                                                          |
| Of those, phone numbers                         | 97                                                                                                           |
| Not phone numbers                               | 4 — `17.03.2004` (founding date), `150 000` (price), `08 - 20` (opening hours), `2006-2026` (copyright span) |
| `tel:` links in the markup                      | 100, 97 distinct                                                                                             |
| Landlines / mobiles                             | 80 / 17                                                                                                      |
| Cities recovered from landline area codes alone | 14                                                                                                           |

Extraction finds the same 97 from the visible text with every tag stripped as it
does from the full markup, so the result does not depend on the site happening
to use `tel:` links.
