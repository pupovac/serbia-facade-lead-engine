/**
 * The "website" the `example` adapter crawls.
 *
 * A real adapter points at a real host. This one points at a local HTTP server
 * that serves `__fixtures__/`, which is what lets the reference adapter
 * exercise the *whole* contract — robots.txt, pagination, the rate limiter, the
 * retry ladder, resume state — in CI, with no network access.
 *
 * Run it on its own to try the CLI against it:
 *
 * ```
 * npx tsx src/scraper/sources/example/fixture-server.ts    # prints its URL
 * npm run scrape -- --source example --dry-run
 * ```
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FIXTURES = new URL('./__fixtures__/', import.meta.url);

/** URL path → fixture file. The shape of a small Serbian company directory. */
const ROUTES: Readonly<Record<string, string>> = {
  '/robots.txt': 'robots.txt',
  '/firme/fasaderi': 'listing-1.html',
  '/firme/fasaderi?strana=1': 'listing-1.html',
  '/firme/fasaderi?strana=2': 'listing-2.html',
  '/firme/termo-fasade-novi-sad': 'detalj-termo-fasade-novi-sad.html',
  '/firme/fasaderski-radovi-markovic': 'detalj-fasaderski-radovi-markovic.html',
  '/firme/stovariste-gradnja-plus': 'detalj-stovariste-gradnja-plus.html',
  '/firme/demit-fasade-beograd': 'detalj-demit-fasade-beograd.html',
  '/firme/izolacija-majstor-uzice': 'detalj-izolacija-majstor-uzice.html',
  '/firme/gradjevinski-centar-nis': 'detalj-gradjevinski-centar-nis.html',
};

export interface FixtureServer {
  readonly url: string;
  /** Every path served, in order. Tests assert on it — including what was *not* fetched. */
  readonly requests: readonly string[];
  /** Forget what has been served, so a second run can be asserted on its own. */
  reset(): void;
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  /** Serve the post-redesign listing, so the run meets a `StructureChangedError`. */
  readonly redesigned?: boolean;
  /** Paths that answer 500 the first `n` times, to exercise the retry ladder. */
  readonly flaky?: Readonly<Record<string, number>>;
}

export async function startFixtureServer(
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const requests: string[] = [];
  const remainingFailures = new Map(Object.entries(options.flaky ?? {}));

  const server: Server = createServer((request, response) => {
    const path = request.url ?? '/';
    requests.push(path);

    const failures = remainingFailures.get(path) ?? 0;
    if (failures > 0) {
      remainingFailures.set(path, failures - 1);
      response.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '0' });
      response.end('temporarily unavailable');
      return;
    }

    const withoutQuery = path.split('?')[0] ?? path;
    const file =
      options.redesigned === true && withoutQuery === '/firme/fasaderi'
        ? 'listing-redesigned.html'
        : (ROUTES[path] ?? ROUTES[withoutQuery]);

    if (file === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }

    readFile(fileURLToPath(new URL(file, FIXTURES)), 'utf8').then(
      (body) => {
        response.writeHead(200, {
          'content-type': file.endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8',
        });
        response.end(body);
      },
      () => {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('fixture missing');
      },
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  /* c8 ignore next -- `listen` resolved, so the address is always an object here */
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reset: () => {
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/* c8 ignore start -- the manual entry point, not exercised by the suite */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const running = await startFixtureServer();
  console.log(`example fixture site listening on ${running.url}`);
  console.log(
    `EXAMPLE_SOURCE_BASE_URL=${running.url} npm run scrape -- --source example --dry-run`,
  );
}
/* c8 ignore stop */
