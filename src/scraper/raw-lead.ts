/**
 * `RawLead` — what an adapter emits, and the zod schema that guards it.
 *
 * This is the whole adapter boundary in one shape. An adapter reads a page and
 * describes a business: the strings it found, verbatim, plus the visible text
 * and the links of the block it found them in. It does not canonicalize a
 * phone, resolve a city, pick a website out of a link farm, classify or score —
 * `src/lib` owns every one of those rules and `src/scraper/pipeline.ts` is what
 * calls them. That split is why adding a source is one directory: the parsing
 * is source-specific, everything after it is not.
 *
 * Two ways to fill it, usually both at once:
 *
 * - **Structured fields** — `name`, `city`, `phones`, `website`, … when the
 *   source publishes them as fields (a JSON API, a definition list, microdata).
 * - **Evidence** — `text` and `links`, the record block as it was published.
 *   The pipeline runs the `src/lib` extractors over these, which is how an
 *   obfuscated `ime [at] firma [dot] rs`, a `tel:` href or a Facebook page in
 *   the footer reach a lead without every adapter re-implementing the reading.
 *
 * `sourceUrl` is the exact page the record was read at — never the source's
 * homepage. Provenance is per record, and a claim nobody can re-open is not
 * evidence.
 */
import { z } from 'zod';

/** A scraped anchor, in the shape `src/lib/contact` reads. */
export const scrapedLinkSchema = z.object({
  href: z.string().min(1),
  /** Anchor text, whitespace-collapsed. `www.bimax.rs` and `Web sajt` are both strong signals. */
  text: z.string().optional(),
  rel: z.string().optional(),
});

export type ScrapedLink = z.infer<typeof scrapedLinkSchema>;

/**
 * One business as one source described it, before any normalization.
 *
 * Only `name` and `sourceUrl` are required — `sourceId` is stamped by the
 * framework. A name, a city and a phone is a good lead, and a lead with no
 * email is still a good lead.
 */
export const rawLeadSchema = z.object({
  /** Filled in by the framework from the adapter's id; an adapter may omit it. */
  sourceId: z.string().min(1).optional(),
  /** The exact page this record was read at. */
  sourceUrl: z.url(),

  /** As published, in Serbian. Never translated, never "cleaned". */
  name: z.string().trim().min(1),
  /** `d.o.o.`, `pr`, `szr`, … when the source states it separately. */
  legalForm: z.string().trim().min(1).nullish(),
  registrationNumber: z.string().trim().min(1).nullish(),
  taxId: z.string().trim().min(1).nullish(),

  /** Raw phone strings exactly as published. `064/123-4567` is the expected shape here. */
  phones: z.array(z.string().min(1)).default([]),
  /** Raw email strings, when the source publishes them as a field. */
  emails: z.array(z.string().min(1)).default([]),
  /** The business's own site as published, if the source names it as such. */
  website: z.string().min(1).nullish(),
  /** Facebook / Instagram / Google Maps URLs the source publishes as fields. */
  socials: z.array(z.string().min(1)).default([]),

  /** The place string as published — `Novi Sad`, `Beograd, Vračar`. Resolved downstream. */
  city: z.string().trim().min(1).nullish(),
  address: z.string().trim().min(1).nullish(),
  postalCode: z.string().trim().min(1).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),

  /** Categories the source filed the business under. Feeds classification. */
  categories: z.array(z.string().min(1)).default([]),

  /**
   * The APR (KD-2010) activity code the page printed, four digits, no dot.
   *
   * Only a register-derived source has one; every other adapter leaves both of
   * these unset and the columns stay null. Store **what the page said** — a
   * code that disagrees with the category the record was discovered under, or
   * with APR's own open data, is a fact worth keeping, not one to reconcile at
   * write time.
   *
   * Deliberately typed as a string rather than a four-digit pattern. The shape
   * is the adapter's business, because only the adapter knows how its source
   * prints one, and a record whose activity code came out malformed must still
   * reach the database: it carries a phone number, and the phone number is the
   * deliverable. `kompanije-net` emits this field only when the page's value is
   * digits, and logs the ones it drops.
   */
  activityCode: z.string().trim().min(1).nullish(),
  /** The source's own name for that code: `Malterisanje`. */
  activityName: z.string().trim().min(1).nullish(),

  /**
   * The classification the **source** establishes, for a listing that is
   * pre-filtered by trade.
   *
   * Set this only when being in the listing *is* the evidence — a directory
   * section that holds facade contractors and nothing else. The pipeline then
   * takes this label instead of reading the record's words, because a
   * tradesman called `Srdjan Todić` carries no words to read and scoring him
   * can only produce `UNKNOWN`.
   *
   * `assertedTypeReason` names the category that entitles the claim, in the
   * source's own terms, so the assertion stays arguable from the `sourceUrl`.
   * The inferred label is still computed and kept, for auditing the classifier
   * against a corpus whose answer is known.
   */
  assertedType: z.enum(['FACADE_CONTRACTOR', 'CONSTRUCTION_MATERIAL_STORE', 'BOTH']).nullish(),
  assertedTypeReason: z.string().trim().min(1).nullish(),
  description: z.string().trim().min(1).nullish(),
  openingHours: z.string().trim().min(1).nullish(),

  /** Visible text of the record block. The `src/lib` extractors read this. */
  text: z.string().nullish(),
  /** Links inside the record block, for website / email / social extraction. */
  links: z.array(scrapedLinkSchema).default([]),

  /** Anything source-specific worth keeping in `raw_records` but not modelled here. */
  extra: z.record(z.string(), z.unknown()).default({}),
});

/** The parsed shape — defaults applied, so `phones` and `links` are always arrays. */
export type RawLead = z.infer<typeof rawLeadSchema>;

/** What an adapter writes. Defaults are optional on the way in. */
export type RawLeadInput = z.input<typeof rawLeadSchema>;

export interface RawLeadValidationFailure {
  readonly ok: false;
  /** Flattened zod message, safe to store in `raw_records.validation_error`. */
  readonly error: string;
  /** The payload that failed, for the run log and for `raw_records`. */
  readonly value: unknown;
}

export type RawLeadValidation =
  { readonly ok: true; readonly lead: RawLead } | RawLeadValidationFailure;

/**
 * Validate one adapter emission.
 *
 * A record that fails is **reported**, never silently dropped: the caller
 * stores it in `raw_records` with `status = 'rejected'` and its error, and
 * counts it against the run. A parser that quietly loses one listing in ten is
 * indistinguishable from a source that got smaller.
 */
export function validateRawLead(value: unknown, sourceId: string): RawLeadValidation {
  const withSource =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { sourceId, ...(value as Record<string, unknown>) }
      : value;
  const result = rawLeadSchema.safeParse(withSource);
  if (result.success) return { ok: true, lead: { ...result.data, sourceId } };
  return {
    ok: false,
    error: result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; '),
    value,
  };
}
