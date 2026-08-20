# `src/lib/contact` — email, website and social-profile extraction

Three extractors that turn a scraped page into `lead_contacts` claims: the
addresses, the business's own website, and its Facebook / Instagram / Google
Maps profiles. Nothing here does I/O, and nothing here defines a contact model —
`ContactInput` and `CONTACT_KINDS` come from `src/lib/db`.

```ts
extractEmails(text, { sourceDomain, links?, sourceOwnedEmails? }): ExtractedEmail[]
extractWebsite(links, { sourceDomain }): NormalizedWebsite | null
extractSocials(links, { sourceDomain?, sourceOwnedProfiles? }): ExtractedSocials
toContactInputs({ emails?, website?, socials? }): ContactInput[]
```

Each extractor has a `…WithRejections` twin that also returns what it dropped
and which rule dropped it, which is what the validation report renders.

`resolveFinalWebsite(website, probe)` follows exactly one redirect hop to record
the final host. The probe is injected — a shortener is the only case that needs
it, and `src/lib` outside `db/` does no I/O of its own.

## Why `sourceDomain` is required

Every Serbian listing portal publishes its own email, its own website and its
own Facebook page on every business page it hosts. Without the source domain the
extractors would copy `info@portal-srbija.com` and `facebook.com/Navidiku.rs`
onto thousands of leads. The source domain is what tells a link about the
business apart from a link about the directory.

## Canonical forms

| Channel     | Canonical value                                                                            | Dedup key                                           |
| ----------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Email       | lower-cased address                                                                        | registrable domain, `null` for a free/ISP mailbox   |
| Website     | `https://firma.rs` — https, no `www.`, no trailing slash, no tracking params, query sorted | registrable domain                                  |
| Facebook    | `https://www.facebook.com/<slug>`                                                          | page slug or numeric id                             |
| Instagram   | `https://www.instagram.com/<handle>`                                                       | handle                                              |
| Google Maps | canonical place URL                                                                        | place id, cid, ftid, short-link code or coordinates |

Website canonicalization is idempotent, and forces `https` on purpose:
`HTTP://WWW.Firma.RS/`, `https://firma.rs` and `firma.rs/?utm_source=x` are one
business, so they must produce one key. The scheme the page published is kept
separately as `observedScheme`.

A free-provider address stores **no** domain. `gmail.com` in the indexed dedup
column would merge every sole trader in Serbia into a single lead.

## Rejection rules

Every drop is reported with one of these ids; `REJECTION_RULES` carries the same
list with a one-line summary and a real example for the validation report.

**Email**

| Rule                     | Drops                                                               |
| ------------------------ | ------------------------------------------------------------------- |
| `email_empty_mailto`     | `mailto:` with no address — a "send to a friend" widget             |
| `email_invalid_syntax`   | fails the address grammar or the 64/254-character limits            |
| `email_invalid_domain`   | single-label host, hyphen at a label edge, TLD not 2–24 letters     |
| `email_asset_filename`   | `logo@2x.png` and other asset filenames                             |
| `email_placeholder`      | `example.com`, `yourdomain.com`, template leftovers                 |
| `email_noreply_mailbox`  | `noreply`, `mailer-daemon`, `postmaster`, `abuse`, `bounce`         |
| `email_directory_domain` | the address's registrable domain is the source's                    |
| `email_source_owned`     | the directory's own address on a free provider, declared per source |
| `email_tracking_address` | hex/UUID mailboxes, `+`-tagged trackers, ESP domains                |

Kept on purpose: **free and ISP mailboxes** (`gmail.com`, `beotel.rs`, `sbb.rs` —
most fasaderi are sole traders) and **role addresses on the business's own
domain** (`info@firma.rs`). Both are flagged, never dropped.

**Website**

| Rule                          | Drops                                                                  |
| ----------------------------- | ---------------------------------------------------------------------- |
| `website_unparseable`         | `#`, `tel:`, `javascript:`, relative paths, empty hrefs                |
| `website_source_domain`       | the directory itself or a subdomain of it                              |
| `website_source_sibling`      | the same brand under another TLD — the portal's foreign editions       |
| `website_known_directory`     | another listing portal or classifieds site                             |
| `website_social_network`      | a social profile or a Maps link — the social extractor's job           |
| `website_share_intent`        | share and intent widgets                                               |
| `website_vendor_credit`       | the "web dizajn / izrada sajta / hosting" footer credit                |
| `website_advertising_banner`  | paid banners, recognised by their campaign parameters                  |
| `website_infrastructure`      | CDN, platform, standards and analytics hosts                           |
| `website_asset_or_document`   | PDFs, images, archives                                                 |
| `website_ambiguous_link_farm` | several unlabelled outbound links and nothing saying which is the site |

The last one matters: an advertiser sidebar is not evidence, and attaching a
stranger's website to a lead is worse than recording no website at all.

**Social**

| Rule                          | Drops                                                                    |
| ----------------------------- | ------------------------------------------------------------------------ |
| `social_share_intent`         | `sharer.php`, `share.php`, `/intent/tweet`, `pin/create`, `shareArticle` |
| `social_platform_root`        | the network's home page with no profile in the path                      |
| `social_not_a_profile`        | posts, photos, hashtags, groups, logins, help pages                      |
| `social_directory_profile`    | the directory's own profile, matched by brand or declared per source     |
| `social_no_stable_identifier` | a Maps URL with no place id, cid, ftid or coordinates                    |

## Known limits

- An address published **only as an image** cannot be read. The filename
  lookalikes it produces are dropped by `email_asset_filename`.
- A directory that publishes its own address on a free provider is invisible to
  the domain comparison until a source declares it in `sourceOwnedEmails`;
  `biznisimeniksrbije@gmail.com` on biznisgroup.rs is the worked example.
- `linkedin` and `youtube` are valid `CONTACT_KINDS` but are not extracted here —
  the issue scope is Facebook, Instagram and Google Maps.
- Category pages that list many businesses must be split per row before
  `extractWebsite` is called; it answers "which link belongs to this business",
  not "which of these fifty businesses".

## Fixtures

`fixtures/real-link-sets.ts` holds 19 link sets captured from real Serbian
listing pages on 2026-08-20, in document order, hrefs and anchor text unedited —
including the space inside `http:// www.vns.rs`, the `target="_blank"` that
leaked into a Facebook href, and the Cloudflare-obfuscated address on
biznisgroup.rs. The expected website and profiles for each page are asserted in
the test files.
