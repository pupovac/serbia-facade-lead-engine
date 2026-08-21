/**
 * The polite fetcher, against a real HTTP server on 127.0.0.1.
 *
 * A local server rather than a mocked `fetch`, because what is being tested is
 * behaviour on the wire: the header the host receives, the second request that
 * does or does not arrive, the path that is never requested at all. `requests`
 * is the assertion surface — including, in the robots test, what is missing
 * from it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULTS, type ScraperConfig } from '../config.js';
import { HttpError, RequestBudgetExceededError, RobotsDisallowedError } from '../errors.js';
import { silentLogger } from '../logger.js';
import { encodeForm, PoliteFetcher, parseRetryAfter } from './fetcher.js';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface TestServer {
  readonly url: string;
  readonly requests: string[];
  readonly userAgents: string[];
  close(): Promise<void>;
}

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(handler: Handler): Promise<TestServer> {
  const requests: string[] = [];
  const userAgents: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? '');
    userAgents.push(request.headers['user-agent'] ?? '');
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const testServer: TestServer = {
    url: `http://127.0.0.1:${port}`,
    requests,
    userAgents,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(testServer);
  return testServer;
}

/** No waiting: the delays are asserted elsewhere, on a virtual clock. */
function fetcher(overrides: Partial<ScraperConfig> = {}): PoliteFetcher {
  return new PoliteFetcher({
    config: { ...DEFAULTS, requestDelayMs: 0, backoffBaseMs: 1, ...overrides },
    log: silentLogger,
    sleep: async () => {},
    random: () => 0.5,
  });
}

const ALLOW_ALL = 'User-agent: *\nDisallow:';

function router(routes: Readonly<Record<string, Handler>>): Handler {
  return (request, response) => {
    const handler = routes[(request.url ?? '').split('?')[0] ?? ''];
    if (handler === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    handler(request, response);
  };
}

function text(body: string, status = 200): Handler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  };
}

describe('PoliteFetcher', () => {
  it('sends an honest User-Agent on every request', async () => {
    const server = await serve(
      router({ '/robots.txt': text(ALLOW_ALL), '/firme': text('<h1>Firme</h1>') }),
    );

    await fetcher().text(`${server.url}/firme`);

    expect(server.userAgents).toHaveLength(2);
    for (const agent of server.userAgents) {
      expect(agent).toBe(DEFAULTS.userAgent);
      expect(agent).toMatch(/https?:\/\/|mailto:|@/);
    }
  });

  it('refuses a disallowed path without requesting it', async () => {
    const server = await serve(
      router({
        '/robots.txt': text('User-agent: *\nDisallow: /pretraga'),
        '/pretraga': text('<h1>should never be served</h1>'),
      }),
    );

    await expect(fetcher().text(`${server.url}/pretraga?q=fasader`)).rejects.toThrow(
      RobotsDisallowedError,
    );
    // The whole point: the request never left.
    expect(server.requests).toEqual(['/robots.txt']);
  });

  it('fetches robots.txt once and reuses it', async () => {
    const server = await serve(
      router({ '/robots.txt': text(ALLOW_ALL), '/a': text('a'), '/b': text('b') }),
    );
    const http = fetcher();

    await http.text(`${server.url}/a`);
    await http.text(`${server.url}/b`);

    expect(server.requests).toEqual(['/robots.txt', '/a', '/b']);
    expect(http.stats().robotsFetches).toBe(1);
  });

  it('does not spend the crawl budget on robots.txt', async () => {
    const server = await serve(router({ '/robots.txt': text(ALLOW_ALL), '/a': text('a') }));
    const http = fetcher();

    await http.text(`${server.url}/a`);

    // Refusing to check must never be the cheaper option.
    expect(http.stats().requests).toBe(1);
  });

  it('retries a 503 and succeeds', async () => {
    let attempts = 0;
    const server = await serve(
      router({
        '/robots.txt': text(ALLOW_ALL),
        '/flaky': (_request, response) => {
          attempts += 1;
          if (attempts < 3) {
            response.writeHead(503, { 'retry-after': '0' });
            response.end('busy');
            return;
          }
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<h1>finally</h1>');
        },
      }),
    );
    const http = fetcher({ maxRetries: 3 });

    const result = await http.text(`${server.url}/flaky`);

    expect(result.body).toBe('<h1>finally</h1>');
    expect(result.attempts).toBe(3);
    expect(http.stats().retries).toBe(2);
  });

  it('gives up after the retry cap', async () => {
    const server = await serve(
      router({ '/robots.txt': text(ALLOW_ALL), '/down': text('boom', 500) }),
    );
    const http = fetcher({ maxRetries: 2 });

    await expect(http.text(`${server.url}/down`)).rejects.toThrow(HttpError);
    // The first attempt plus two retries.
    expect(server.requests.filter((path) => path === '/down')).toHaveLength(3);
    expect(http.stats().failures).toBe(1);
  });

  it('never retries a 404 — it is a fact about the page, not a hiccup', async () => {
    const server = await serve(router({ '/robots.txt': text(ALLOW_ALL) }));
    const http = fetcher({ maxRetries: 3 });

    await expect(http.text(`${server.url}/gone`)).rejects.toThrow(HttpError);
    expect(server.requests.filter((path) => path === '/gone')).toHaveLength(1);
  });

  it('stops at the per-run request budget', async () => {
    const server = await serve(
      router({ '/robots.txt': text(ALLOW_ALL), '/a': text('a'), '/b': text('b'), '/c': text('c') }),
    );
    const http = fetcher({ requestBudget: 2 });

    await http.text(`${server.url}/a`);
    await http.text(`${server.url}/b`);

    expect(http.budgetExhausted()).toBe(true);
    await expect(http.text(`${server.url}/c`)).rejects.toThrow(RequestBudgetExceededError);
    expect(server.requests).not.toContain('/c');
    expect(http.stats().budgetRemaining).toBe(0);
  });

  it('takes the crawl-delay from robots.txt when it asks for more room', async () => {
    const server = await serve(
      router({
        '/robots.txt': text('User-agent: *\nCrawl-delay: 3\nDisallow: /admin/'),
        '/a': text('a'),
      }),
    );
    const waits: number[] = [];
    const http = new PoliteFetcher({
      config: { ...DEFAULTS, requestDelayMs: 500, backoffBaseMs: 1 },
      log: silentLogger,
      sleep: async (ms) => {
        waits.push(ms);
      },
      // Frozen, so the assertion is the delay itself rather than the delay
      // minus however long the request happened to take.
      now: () => 0,
      random: () => 0.5,
    });

    await http.text(`${server.url}/a`);
    await http.text(`${server.url}/a`);

    // 3s from robots.txt, not the 500ms we configured.
    expect(waits.at(-1)).toBe(3000);
  });

  it('parses HTML with cheerio', async () => {
    const server = await serve(
      router({
        '/robots.txt': text(ALLOW_ALL),
        '/firme': text('<ul><li class="firma">Termo Fasade</li></ul>'),
      }),
    );

    const { $ } = await fetcher().html(`${server.url}/firme`);

    expect($('li.firma').text()).toBe('Termo Fasade');
  });

  it('parses JSON, and fails loudly when it is not JSON', async () => {
    const server = await serve(
      router({
        '/robots.txt': text(ALLOW_ALL),
        '/api': text('{"firme":[{"naziv":"Termo Fasade"}]}'),
        '/broken': text('<html>an error page</html>'),
      }),
    );
    const http = fetcher();

    const { data } = await http.json<{ firme: { naziv: string }[] }>(`${server.url}/api`);
    expect(data.firme[0]?.naziv).toBe('Termo Fasade');

    await expect(http.json(`${server.url}/broken`)).rejects.toThrow(SyntaxError);
  });

  it('reports the robots rule that permitted a request', async () => {
    const server = await serve(
      router({ '/robots.txt': text('User-agent: *\nAllow: /firme/'), '/firme/x': text('x') }),
    );

    const result = await fetcher().text(`${server.url}/firme/x`);

    expect(result.robotsRule).toBe('Allow: /firme/');
  });
});

describe('form POST', () => {
  /**
   * The capability exists for one shape of source: a directory that publishes a
   * phone number but only renders it when a button asks for it. Replaying that
   * request is a read, and it has to stay inside every guarantee a GET has.
   */
  it('sends a url-encoded POST and returns the body', async () => {
    const bodies: string[] = [];
    const methods: string[] = [];
    const types: string[] = [];
    const server = await serve(
      router({
        '/robots.txt': text(ALLOW_ALL),
        '/master/show_tel/': (request, response) => {
          methods.push(request.method ?? '');
          types.push(request.headers['content-type'] ?? '');
          let body = '';
          request.on('data', (chunk) => {
            body += String(chunk);
          });
          request.on('end', () => {
            bodies.push(body);
            response.writeHead(200, { 'content-type': 'text/html' });
            response.end('{"ind":1,"html":"<a href=\\"tel:0645880669\\">x<\\/a>"}');
          });
        },
      }),
    );

    const result = await fetcher().text(`${server.url}/master/show_tel/`, { form: { id: '2298' } });

    expect(methods).toEqual(['POST']);
    expect(bodies).toEqual(['id=2298']);
    expect(types[0]).toContain('application/x-www-form-urlencoded');
    expect(result.body).toContain('0645880669');
  });

  it('checks robots.txt for the endpoint like any other request', async () => {
    const server = await serve(
      router({
        '/robots.txt': text('User-agent: *\nDisallow: /master/'),
        '/master/show_tel/': text('{"ind":1}'),
      }),
    );

    await expect(
      fetcher().text(`${server.url}/master/show_tel/`, { form: { id: '1' } }),
    ).rejects.toThrow(RobotsDisallowedError);
    expect(server.requests).toEqual(['/robots.txt']);
  });

  /**
   * A `URLSearchParams` body is spent once it is read, so a retried POST has to
   * build its own. Without that, the second attempt sends an empty body and the
   * endpoint answers "unknown id" — a phone lost to a transient 503.
   */
  it('re-encodes the body on a retry rather than replaying a spent one', async () => {
    const bodies: string[] = [];
    let attempt = 0;
    const server = await serve(
      router({
        '/robots.txt': text(ALLOW_ALL),
        '/master/show_tel/': (request, response) => {
          let body = '';
          request.on('data', (chunk) => {
            body += String(chunk);
          });
          request.on('end', () => {
            bodies.push(body);
            attempt += 1;
            if (attempt === 1) {
              response.writeHead(503);
              response.end('busy');
              return;
            }
            response.writeHead(200, { 'content-type': 'text/html' });
            response.end('{"ind":1}');
          });
        },
      }),
    );

    await fetcher().text(`${server.url}/master/show_tel/`, { form: { id: '2298' } });

    expect(bodies).toEqual(['id=2298', 'id=2298']);
  });

  it('stays a GET when no form is given', async () => {
    const methods: string[] = [];
    const server = await serve(
      router({
        '/robots.txt': text(ALLOW_ALL),
        '/page': (request, response) => {
          methods.push(request.method ?? '');
          text('<h1>ok</h1>')(request, response);
        },
      }),
    );

    await fetcher().text(`${server.url}/page`);
    expect(methods).toEqual(['GET']);
  });
});

describe('encodeForm', () => {
  it('encodes the way a browser does', () => {
    expect(encodeForm({ id: '2298' })).toBe('id=2298');
    expect(encodeForm({ q: 'građevinski materijal' })).toBe('q=gra%C4%91evinski+materijal');
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds', () => {
    expect(parseRetryAfter('30', 0)).toBe(30_000);
    expect(parseRetryAfter('0', 0)).toBe(0);
  });

  it('reads an HTTP date', () => {
    const now = Date.parse('2026-08-20T10:00:00Z');
    expect(parseRetryAfter('Thu, 20 Aug 2026 10:00:30 GMT', now)).toBe(30_000);
    // A date already in the past means "now", not a negative wait.
    expect(parseRetryAfter('Thu, 20 Aug 2026 09:59:00 GMT', now)).toBe(0);
  });

  it('reports nothing for a missing or unreadable header', () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('soon', 0)).toBeNull();
  });
});
