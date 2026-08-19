## Executed Overpass results

Every query in this directory was run against the live API on **2026-08-19**
(Overpass API 0.7.62.11, `timestamp_osm_base` 2026-08-19T21:22Z). The counts
below are what the API returned, not estimates.

Re-run any file:

```bash
curl -s -G https://overpass-api.de/api/interpreter \
  --data-urlencode "data@03-contractors-craft.overpassql"
```

`overpass-api.de` round-robins across mirrors and one of them returned HTTP 504
intermittently during this pass. Retry, or fall back to
`https://overpass.kumi.systems/api/interpreter` — same query language, same data.

| Query                              |                      Elements | With phone | With website |
| ---------------------------------- | ----------------------------: | ---------: | -----------: |
| `01-stores-all-tags.overpassql`    |                           794 |  339 (43%) |          286 |
| `02-stores-with-phone.overpassql`  |                           339 | 339 (100%) |          244 |
| `03-contractors-craft.overpassql`  |                            43 |   15 (35%) |           10 |
| `04-contractors-office.overpassql` |                            29 |   24 (83%) |           22 |
| `05-craft-census.overpassql`       |                           697 |  285 (41%) |            — |
| `06-admin-units.overpassql`        | 154 (admin_level=8 relations) |          — |            — |

`.result.json` is kept for the two small contractor-side queries, which are the
ones the recommendation turns on. The three large store/craft responses were
dropped from the repo — re-run the query, it takes about 20 seconds.

### The number that decided the OSM question

`craft=plasterer` + `craft=painter` + `craft=builder` across the whole of Serbia:

**4 elements. 1 of them carries a phone number.**

Breakdown of every `craft=*` value in Serbia (from `05-craft-census`): the top
value is `metal_construction` at 92. `plasterer` is 1, `painter` is 3, `tiler`
is 1, `builder` is 0, `roofer` is 0, `insulation` is 0. The total craft census
is 697 businesses for a country of 6.6 million people — OSM in Serbia does not
map small trade businesses at all. This is a coverage gap, not a tagging
mistake, so no alternative tag rescues it.

Store-side coverage is real but thin on the field that matters: 794 shops, 339
with a phone (43%). By comparison the same businesses in Overture Maps carry a
phone 94% of the time.

### Other counts collected during this pass

| Measure                                     |                               Value |
| ------------------------------------------- | ----------------------------------: |
| `office=construction_company`, Serbia       |                  29 (24 with phone) |
| `place=city` nodes                          |                                  28 |
| `place=town` nodes                          |                                 138 |
| `place=village` nodes                       |                               4,149 |
| `admin_level=6` relations (okruzi)          |                                  26 |
| `admin_level=7` relations                   | 34 (incomplete in OSM — do not use) |
| `admin_level=8` relations (opštine/gradovi) |                                 154 |

`admin_level=8` returns 154 against the 145 official local self-government
units in `data/serbia-geo.json` (FUZZ-6); the surplus is Belgrade city
municipalities mapped at level 8. Use `data/serbia-geo.json` as the crawl
target list, not OSM boundaries.
