/**
 * Enrichment suggestions — the medium-confidence findings.
 *
 * Enrichment has three outcomes, not two. A page that is *probably* the same
 * business is the common case in a country with many `Fasade Petrović`, and
 * both binary answers are wrong: merging writes a competitor's phone onto a
 * lead and nobody notices, discarding throws away most of what enrichment is
 * for. So the finding is queued with its evidence and a human decides here.
 *
 * Accepting writes the value onto the lead with the reviewer as provenance.
 * Rejecting is remembered: `rejectedValues()` is read by the enrichment run
 * before it merges anything, so a value a human said no to is never promoted
 * later by one more corroborating signal.
 */
import Link from 'next/link';
import { suggestionQueue } from '@/lib/review';
import { db } from '../lib/db';
import { CONTACT_LABELS, formatDate, formatNumber, formatPhone, shortUrl } from '../lib/format';
import { ClassificationBadge, Empty, Pager, Panel, Score } from '../components/ui';
import { acceptSuggestionAction, rejectSuggestionAction } from '../actions';

const KIND_LABELS: Record<string, string> = {
  ...CONTACT_LABELS,
  phone: 'Telefon',
  address: 'Adresa',
  city: 'Grad',
};

const ORIGIN_EXPLANATION: Record<string, string> = {
  own_site: 'sa domena koji lead već nosi — po konstrukciji je njihov',
  discovered: 'sa stranice koju je pronašla pretraga — pripada leadu samo ako dokazi to kažu',
};

export default async function SuggestionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.page) ? params.page[0] : params.page;
  const page = suggestionQueue(db(), Number.parseInt(raw ?? '1', 10) || 1, 10);

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Predlozi obogaćivanja</h1>
          <p className="subtitle">
            {formatNumber(page.total)} nalaza srednje pouzdanosti čeka odluku — crawler ih je našao,
            ali nije bio dovoljno siguran da ih sam upiše.
          </p>
        </div>
      </div>

      {page.total === 0 ? (
        <div className="table-wrap">
          <Empty>
            Nema predloga na čekanju. Odbijeni predlozi se pamte, pa ih naredni prolaz obogaćivanja
            ne otvara ponovo.
          </Empty>
        </div>
      ) : (
        <>
          {page.items.map(({ suggestion, lead, existingPhones, existingContacts }) => {
            const alreadyKnown =
              suggestion.kind === 'phone'
                ? existingPhones.includes(suggestion.value)
                : existingContacts.some((contact) => contact.value === suggestion.value);

            return (
              <article className="candidate" key={suggestion.id}>
                <div className="pair-head">
                  <strong>
                    <span className="badge accent">
                      {KIND_LABELS[suggestion.kind] ?? suggestion.kind}
                    </span>{' '}
                    <span className="mono">
                      {suggestion.kind === 'phone'
                        ? formatPhone(suggestion.value)
                        : shortUrl(suggestion.value, 60)}
                    </span>{' '}
                    <span className="badge warn">
                      pouzdanost {suggestion.confidence.toFixed(2)}
                    </span>
                    {alreadyKnown ? <span className="badge good"> lead ovo već ima</span> : null}
                  </strong>
                  <span className="small muted">
                    prvi put viđen {formatDate(suggestion.firstSeenAt)}
                  </span>
                </div>

                <div className="pair">
                  <div>
                    <div className="small muted">Predlaže se za</div>
                    <h2 style={{ marginBottom: 4 }}>
                      <Link href={`/leads/${lead.id}`}>{lead.name}</Link>
                    </h2>
                    <p className="small" style={{ marginTop: 0 }}>
                      <span className="mono muted">#{lead.id}</span> · {lead.cityRaw ?? '—'} ·{' '}
                      <ClassificationBadge value={lead.classification} />{' '}
                      <Score value={lead.leadScore} />
                    </p>

                    <h3>Već poznati telefoni ({existingPhones.length})</h3>
                    {existingPhones.length === 0 ? (
                      <p className="muted small" style={{ margin: 0 }}>
                        nijedan — ovaj predlog bi bio prvi broj na leadu
                      </p>
                    ) : (
                      <ul className="plain small mono">
                        {existingPhones.map((phone) => (
                          <li key={phone}>{formatPhone(phone)}</li>
                        ))}
                      </ul>
                    )}

                    {existingContacts.length > 0 ? (
                      <>
                        <h3 style={{ marginTop: 10 }}>Već poznati kanali</h3>
                        <ul className="plain small mono">
                          {existingContacts.slice(0, 6).map((contact) => (
                            <li key={contact.id}>
                              <span className="muted">{contact.kind}</span>{' '}
                              {shortUrl(contact.value, 44)}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </div>

                  <div>
                    <div className="small muted">Zašto je ovo neizvesno</div>
                    <p style={{ marginTop: 4 }}>{suggestion.reason}</p>

                    <dl className="kv small">
                      <dt>Pravilo</dt>
                      <dd className="mono">{suggestion.rule}</dd>
                      <dt>Poreklo</dt>
                      <dd>
                        <span className="badge">{suggestion.origin}</span>{' '}
                        <span className="muted">{ORIGIN_EXPLANATION[suggestion.origin] ?? ''}</span>
                      </dd>
                      <dt>Pročitano na</dt>
                      <dd>
                        <a href={suggestion.sourceUrl} target="_blank" rel="noreferrer noopener">
                          {shortUrl(suggestion.sourceUrl, 52)}
                        </a>
                      </dd>
                      <dt>Kako je objavljeno</dt>
                      <dd className="mono">{suggestion.valueRaw ?? suggestion.value}</dd>
                    </dl>

                    <h3 style={{ marginTop: 10 }}>Dokazi</h3>
                    <pre className="evidence">{formatEvidence(suggestion.evidence)}</pre>
                  </div>
                </div>

                <div className="foot">
                  <span className="why">
                    Prihvatanje upisuje vrednost na lead sa <code>manual-review</code> kao izvorom;
                    odbijanje se pamti i naredni prolaz ga ne otvara ponovo.
                  </span>
                  <form action={acceptSuggestionAction}>
                    <input type="hidden" name="suggestionId" value={suggestion.id} />
                    <button className="primary" type="submit">
                      Prihvati
                    </button>
                  </form>
                  <form action={rejectSuggestionAction}>
                    <input type="hidden" name="suggestionId" value={suggestion.id} />
                    <button className="danger" type="submit">
                      Odbij
                    </button>
                  </form>
                </div>
              </article>
            );
          })}

          <Pager
            page={page.page}
            pageCount={page.pageCount}
            total={page.total}
            unit="predloga"
            href={(next) => `/suggestions?page=${next}`}
          />
        </>
      )}

      <Panel title="Zašto ovaj red postoji">
        <p style={{ margin: 0 }}>
          Nalaz sa <strong>own_site</strong> porekla dolazi sa domena koji lead već nosi i po
          konstrukciji pripada tom poslu. Nalaz sa <strong>discovered</strong> porekla dolazi sa
          stranice koju je pronašla pretraga — tu pogrešno spajanje upisuje konkurentov broj na lead
          i niko to nikada ne primeti. Zato ovaj red postoji umesto da crawler pogađa.
        </p>
      </Panel>
    </main>
  );
}

/** Pretty-print the stored evidence JSON; show it raw if it is not JSON. */
function formatEvidence(evidence: string): string {
  try {
    return JSON.stringify(JSON.parse(evidence), null, 2);
  } catch {
    return evidence;
  }
}

export const dynamic = 'force-dynamic';
