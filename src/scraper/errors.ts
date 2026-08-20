/**
 * The failures the framework distinguishes.
 *
 * The one that matters most is `StructureChangedError`. A directory that
 * redesigns its listing markup does not start returning errors — it starts
 * returning pages our selectors no longer match, and a crawler that treats
 * "nothing matched" as "nothing there" reports a healthy run with zero leads
 * for weeks. So a selector that matches nothing is a failure here, never an
 * empty result, and it carries the URL and the selector that broke so the fix
 * starts from a fact rather than a bisect.
 *
 * The rest exist to separate what should stop a run (a robots disallow, an
 * exhausted request budget, a misconfigured crawler) from what should only be
 * counted against one item (a timeout, a 500, a record that failed validation).
 */

/** Base class, so `catch (e) { if (e instanceof ScraperError) … }` is meaningful. */
export class ScraperError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

export interface StructureChangedDetail {
  readonly sourceId: string;
  /** The page whose markup no longer matches. */
  readonly url: string;
  /** The selector, JSON path or field name that came back empty. */
  readonly selector: string;
  /** What the adapter expected to find, in a sentence a human can act on. */
  readonly expected?: string | undefined;
}

/**
 * A selector matched nothing where the adapter guarantees something.
 *
 * Adapters raise this through `ctx.expect(...)` / `expectSelector(...)` rather
 * than constructing it by hand, so the message stays uniform across sources.
 */
export class StructureChangedError extends ScraperError {
  readonly detail: StructureChangedDetail;

  constructor(detail: StructureChangedDetail) {
    super(
      `[${detail.sourceId}] structure changed at ${detail.url}: ` +
        `\`${detail.selector}\` matched nothing` +
        (detail.expected === undefined ? '' : ` — expected ${detail.expected}`),
    );
    this.detail = detail;
  }
}

/** `robots.txt` forbids this path for our User-Agent. Never retried, never worked around. */
export class RobotsDisallowedError extends ScraperError {
  constructor(
    readonly url: string,
    /** The verbatim rule that produced the verdict, for the run log. */
    readonly rule: string,
  ) {
    super(`robots.txt disallows ${url} (${rule})`);
  }
}

/**
 * The run hit its hard request ceiling.
 *
 * Thrown by the fetcher and caught by the orchestrator, which ends the run
 * cleanly rather than crashing: the budget exists so a pagination bug cannot
 * hammer a small Serbian site, and tripping it is a stop, not a stack trace.
 */
export class RequestBudgetExceededError extends ScraperError {
  constructor(readonly budget: number) {
    super(`per-run request budget of ${budget} requests exhausted`);
  }
}

/** A non-2xx response the fetcher gave up on. `retryable` says whether it ever could have worked. */
export class HttpError extends ScraperError {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly attempts: number,
    readonly retryable: boolean,
  ) {
    super(`GET ${url} failed with ${status} after ${attempts} attempt(s)`);
  }
}

/** The crawler is not configured well enough to be polite. Refuses to start. */
export class ScraperConfigError extends ScraperError {}
