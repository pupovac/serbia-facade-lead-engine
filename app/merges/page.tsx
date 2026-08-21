/**
 * The merge review queue.
 *
 * This is the page that makes the middle confidence band useful. The dedup
 * engine merges what it is sure about and refuses what it is not; the pairs in
 * between — 347 of them in the pilot — are here, side by side, ordered by score
 * so the strongest evidence is decided first.
 *
 * Both actions are terminal in the right way: a merge is transactional, writes
 * `merge_log` with a snapshot and can be undone from the survivor's detail
 * page; a rejection is remembered, so the next sweep does not re-ask.
 */
import Link from 'next/link';
import { mergeQueue, type CandidateSide } from '@/lib/review';
import { db } from '../lib/db';
import { formatDate, formatNumber, formatPhone, shortUrl } from '../lib/format';
import { ClassificationBadge, Empty, Pager, Score, SourceUrl } from '../components/ui';
import { mergePairAction, rejectPairAction } from '../actions';

/**
 * One entry of `merge_candidates.signals` — every signal `scoreMatch` weighed,
 * including the ones that argued against. `detail` is the engine's own sentence
 * about this pair; `role` says whether it decided, corroborated or merely
 * supported.
 */
interface MatchSignalRow {
  readonly kind: string;
  readonly value?: string;
  readonly weight?: number;
  readonly role?: string;
  readonly detail?: string;
}

/** How the engine reached the pair, in a sentence a reviewer can argue with. */
const SIGNAL_EXPLANATION: Record<string, string> = {
  phone: 'isti broj telefona',
  website_domain: 'isti domen sajta',
  email: 'ista e-pošta',
  registration_number: 'isti matični broj',
  name_city: 'vrlo sličan naziv u istom mestu',
  address: 'ista adresa',
  social_profile: 'isti profil na društvenoj mreži',
  manual: 'ručno',
};

function Side({ side, label }: { side: CandidateSide; label: string }) {
  return (
    <div>
      <div className="small muted">{label}</div>
      <h2 style={{ marginBottom: 4 }}>
        <Link href={`/leads/${side.lead.id}`}>{side.lead.name}</Link>
      </h2>
      <p className="small" style={{ marginTop: 0 }}>
        <span className="mono muted">#{side.lead.id}</span> ·{' '}
        <ClassificationBadge value={side.lead.classification} />{' '}
        <Score value={side.lead.leadScore} />
      </p>

      <dl className="kv small">
        <dt>Grad</dt>
        <dd>{side.lead.cityRaw ?? '—'}</dd>
        <dt>Opština</dt>
        <dd className="mono">{side.lead.municipalityId ?? '—'}</dd>
        <dt>Adresa</dt>
        <dd>{side.lead.address ?? '—'}</dd>
        <dt>Matični broj</dt>
        <dd className="mono">{side.lead.registrationNumber ?? '—'}</dd>
        <dt>Prvi put</dt>
        <dd>{formatDate(side.lead.firstSeenAt)}</dd>
      </dl>

      <h3 style={{ marginTop: 10 }}>Telefoni ({side.phones.length})</h3>
      {side.phones.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          nema ispravnog broja
        </p>
      ) : (
        <ul className="plain small mono">
          {side.phones.map((phone) => (
            <li key={phone.e164}>
              {formatPhone(phone.e164)}{' '}
              <span className="muted">({phone.sourceIds.join(', ')})</span>
            </li>
          ))}
        </ul>
      )}

      {side.contacts.length > 0 ? (
        <>
          <h3 style={{ marginTop: 10 }}>Kanali</h3>
          <ul className="plain small mono">
            {side.contacts.slice(0, 5).map((contact) => (
              <li key={contact.id}>{shortUrl(contact.value, 40)}</li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 style={{ marginTop: 10 }}>
        Izvori ({side.sourceCount} nezavisnih, {side.sightings.length} URL-ova)
      </h3>
      <ul className="plain small">
        {side.sightings.slice(0, 4).map((sighting) => (
          <li key={sighting.id}>
            <SourceUrl
              url={sighting.sourceUrl}
              browsable={sighting.browsable}
              label={shortUrl(sighting.sourceUrl, 46)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function MergeQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.page) ? params.page[0] : params.page;
  const page = mergeQueue(db(), Number.parseInt(raw ?? '1', 10) || 1, 5);

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Red za spajanje</h1>
          <p className="subtitle">
            {formatNumber(page.total)} parova koje je dedup ocenio kao „za pregled” — dovoljno
            slično da nije slučajno, premalo dokaza da bi mašina odlučila sama.
          </p>
        </div>
      </div>

      {page.total === 0 ? (
        <div className="table-wrap">
          <Empty>
            Nema parova na čekanju. Odbijeni parovi se ne vraćaju u red — to je i razlog zašto ovaj
            red ostaje čitljiv.
          </Empty>
        </div>
      ) : (
        <>
          {page.pairs.map(({ candidate, a, b }) => {
            const signals = ((): MatchSignalRow[] => {
              try {
                const parsed: unknown = JSON.parse(candidate.signals);
                return Array.isArray(parsed) ? (parsed as MatchSignalRow[]) : [];
              } catch {
                return [];
              }
            })();

            return (
              <article className="candidate" key={candidate.id}>
                <div className="pair-head">
                  <strong>
                    Par #{candidate.id} ·{' '}
                    <span className="badge accent">{candidate.score.toFixed(2)}</span>{' '}
                    <span className="badge">{candidate.topSignal}</span>{' '}
                    <span className="muted">
                      {SIGNAL_EXPLANATION[candidate.topSignal] ?? candidate.topSignal}:{' '}
                      <span className="mono">{candidate.signalValue}</span>
                    </span>
                  </strong>
                  <span className="small muted">
                    prvi put viđen {formatDate(candidate.firstSeenAt)}
                  </span>
                </div>

                <div className="pair">
                  <Side side={a} label="A — zadrži ovaj" />
                  <Side side={b} label="B — zadrži ovaj" />
                </div>

                {signals.length > 0 ? (
                  <div style={{ padding: '8px 14px' }}>
                    <h3 style={{ marginBottom: 4 }}>Svi izmereni signali</h3>
                    <table className="compact">
                      <tbody>
                        {signals.map((entry, index) => (
                          <tr key={`${entry.kind}-${index}`}>
                            <td className="small nowrap">
                              <span className="badge">{entry.kind}</span>
                            </td>
                            <td className="small">
                              {/* `detail` is the sentence the dedup engine wrote
                                  about this pair — the reviewer argues with
                                  that, not with the weight. */}
                              {entry.detail ?? entry.value}
                            </td>
                            <td className="small muted nowrap">{entry.role}</td>
                            <td className="num small nowrap">
                              {typeof entry.weight === 'number' ? entry.weight.toFixed(2) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                <div className="foot">
                  <span className="why">
                    Spajanje je transakciono, upisuje se u <code>merge_log</code> sa snimkom stanja
                    i može se poništiti sa strane preživelog leada.
                  </span>
                  <form action={mergePairAction}>
                    <input type="hidden" name="candidateId" value={candidate.id} />
                    <input type="hidden" name="survivingLeadId" value={a.lead.id} />
                    <button className="primary" type="submit">
                      Spoji — zadrži A (#{a.lead.id})
                    </button>
                  </form>
                  <form action={mergePairAction}>
                    <input type="hidden" name="candidateId" value={candidate.id} />
                    <input type="hidden" name="survivingLeadId" value={b.lead.id} />
                    <button className="primary" type="submit">
                      Spoji — zadrži B (#{b.lead.id})
                    </button>
                  </form>
                  <form action={rejectPairAction}>
                    <input type="hidden" name="candidateId" value={candidate.id} />
                    <button className="danger" type="submit">
                      Nisu isti
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
            unit="parova"
            href={(next) => `/merges?page=${next}`}
          />
        </>
      )}
    </main>
  );
}

export const dynamic = 'force-dynamic';
