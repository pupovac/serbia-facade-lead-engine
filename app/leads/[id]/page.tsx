/**
 * The lead detail page — everything known about one business, and where each
 * piece of it came from.
 *
 * The organising idea is the schema's: nothing here stores "the value", it
 * stores a claim. So every phone lists the sources that published it, every
 * field shows the value that won and the values that lost, and a human edit is
 * marked as a human edit. A reviewer who cannot see why the row says what it
 * says cannot correct it.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  humanFieldEdits,
  leadDetail,
  overriddenHumanEdits,
  REVIEWER_SOURCE_ID,
} from '@/lib/review';
import { getMunicipalityById } from '@/lib/geo';
import type { ClassificationResult } from '@/lib/classify';
import type { LeadScore, ScoreComponent } from '@/lib/score';
import { db } from '../../lib/db';
import {
  CLASSIFICATION_LABELS,
  CONTACT_LABELS,
  FIELD_LABELS,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPhone,
  phoneTypeLabel,
  shortUrl,
} from '../../lib/format';
import { ClassificationBadge, Panel, Score, SourceUrl, StatusBadge } from '../../components/ui';
import { editFieldAction, setStatusAction, undoMergeAction } from '../../actions';
import { EditableFields, StatusForm } from './forms';

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const leadId = Number.parseInt(id, 10);
  if (!Number.isFinite(leadId)) notFound();

  const handle = db();
  const detail = leadDetail(handle, leadId);
  if (!detail) notFound();

  const { lead } = detail;
  const municipality = lead.municipalityId ? getMunicipalityById(lead.municipalityId) : undefined;
  const edits = humanFieldEdits(handle, lead.id);
  const editedFields = new Set(
    edits.filter((claim) => claim.isCurrent).map((claim) => claim.field),
  );
  const overridden = overriddenHumanEdits(handle, lead.id);
  const classification = parseJson<ClassificationResult>(lead.classificationEvidence);

  // `score_breakdown` is written as a bare component array by the scorer and as
  // the full `LeadScore` envelope by other callers. Both are in the pilot data,
  // so both are read rather than one of them crashing the page.
  const scoreRaw = parseJson<LeadScore | ScoreComponent[]>(lead.scoreBreakdown);
  const scoreComponents: readonly ScoreComponent[] = Array.isArray(scoreRaw)
    ? scoreRaw
    : (scoreRaw?.components ?? []);
  const scoreCapped = !Array.isArray(scoreRaw) && scoreRaw?.capped === true;

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>
            {lead.name}{' '}
            {editedFields.has('name') ? <span className="badge human">ispravio čovek</span> : null}
          </h1>
          <p className="subtitle">
            <span className="mono">#{lead.id}</span> · {lead.cityRaw ?? '—'}
            {municipality ? ` · ${municipality.name_sr} (${municipality.district})` : ''} ·{' '}
            <ClassificationBadge value={lead.classification} /> <Score value={lead.leadScore} />{' '}
            <StatusBadge value={lead.status} />
          </p>
        </div>
        <div className="actions">
          <Link className="button" href="/leads">
            ‹ Nazad na listu
          </Link>
        </div>
      </div>

      {detail.resolvesTo ? (
        <div className="notice">
          Ovaj zapis je spojen u{' '}
          <Link href={`/leads/${detail.resolvesTo.id}`}>
            {detail.resolvesTo.name} (#{detail.resolvesTo.id})
          </Link>
          . Zadržan je da bi svaki ikada izdati id i dalje radio.
        </div>
      ) : null}

      {overridden.length > 0 ? (
        <div className="notice bad">
          Mašinski prolaz je pregazio ljudsku odluku:{' '}
          {overridden
            .map((claim) => `${FIELD_LABELS[claim.field] ?? claim.field} → „${claim.value}”`)
            .join(', ')}
          . Ljudska tvrdnja je sačuvana u <code>lead_field_values</code>, ali kolona na{' '}
          <code>leads</code> više ne odgovara. Ovo prijavljuje FUZZ-25 kao rupu u{' '}
          <code>applyGrading()</code>.
        </div>
      ) : null}

      <div className="grid side">
        <div>
          <Panel title="Telefoni — glavni isporučivi podatak">
            {detail.phones.length === 0 ? (
              <p className="muted">Nijedan broj nije prošao parsiranje.</p>
            ) : (
              <table className="compact">
                <thead>
                  <tr>
                    <th>Broj</th>
                    <th>Tip</th>
                    <th>Kako je objavljen</th>
                    <th>Izvori</th>
                    <th className="num">Prvi put</th>
                    <th className="num">Poslednji put</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.phones.map((phone) => (
                    <tr key={phone.e164}>
                      <td className="mono nowrap">
                        <strong>{formatPhone(phone.e164)}</strong>
                        {phone.isPrimary ? <span className="badge accent"> primarni</span> : null}
                        <div className="muted small">{phone.e164}</div>
                      </td>
                      <td className="small">{phoneTypeLabel(phone.type)}</td>
                      <td className="small mono">
                        {phone.rawVariants.map((raw) => (
                          <div key={raw}>{raw}</div>
                        ))}
                      </td>
                      <td className="small">
                        {phone.sourceIds.map((sourceId) => (
                          <div key={sourceId}>
                            <span
                              className={sourceId === REVIEWER_SOURCE_ID ? 'badge human' : 'mono'}
                            >
                              {sourceId === REVIEWER_SOURCE_ID ? 'čovek' : sourceId}
                            </span>
                          </div>
                        ))}
                      </td>
                      <td className="num small muted nowrap">{formatDate(phone.firstSeenAt)}</td>
                      <td className="num small muted nowrap">{formatDate(phone.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {detail.invalidPhones.length > 0 ? (
              <>
                <h3 style={{ marginTop: 14 }}>
                  Neispravni zapisi ({detail.invalidPhones.length}) — nisu telefoni
                </h3>
                <p className="small muted" style={{ marginTop: 0 }}>
                  Sačuvani su radi revizije, ne broje se kao kontakt. Najčešće su to oznake
                  odeljenja koje parser nije mogao da pročita. FUZZ-33 rešava stranu unosa.
                </p>
                <ul className="plain small mono">
                  {detail.invalidPhones.map((phone) => (
                    <li key={phone.e164}>
                      {phone.e164}{' '}
                      <span className="muted">
                        ({phone.rawVariants.join(' · ')} — {phone.sourceIds.join(', ')})
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Panel>

          <Panel title={`Kontakt kanali (${detail.contacts.length})`}>
            {detail.contacts.length === 0 ? (
              <p className="muted">
                Nema e-pošte, sajta ni profila. Lead sa telefonom je i dalje dobar lead.
              </p>
            ) : (
              <table className="compact">
                <thead>
                  <tr>
                    <th>Kanal</th>
                    <th>Vrednost</th>
                    <th>Izvor</th>
                    <th className="num">Viđeno</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.contacts.map((contact) => (
                    <tr key={contact.id}>
                      <td className="small">{CONTACT_LABELS[contact.kind] ?? contact.kind}</td>
                      <td className="mono small">
                        {contact.kind === 'email' ? (
                          <a href={`mailto:${contact.value}`}>{contact.value}</a>
                        ) : (
                          <a href={contact.value} target="_blank" rel="noreferrer noopener">
                            {shortUrl(contact.value)}
                          </a>
                        )}
                      </td>
                      <td className="small">
                        <span
                          className={
                            contact.sourceId === REVIEWER_SOURCE_ID ? 'badge human' : 'mono'
                          }
                        >
                          {contact.sourceId === REVIEWER_SOURCE_ID ? 'čovek' : contact.sourceId}
                        </span>
                      </td>
                      <td className="num small muted nowrap">{formatDate(contact.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title={`Gde je viđen (${detail.sightings.length} URL-ova, ${detail.sourceCount} izvora)`}
          >
            <table className="compact">
              <thead>
                <tr>
                  <th>Izvor</th>
                  <th>URL</th>
                  <th className="num">Puta</th>
                  <th className="num">Prvi put</th>
                  <th className="num">Poslednji crawl</th>
                </tr>
              </thead>
              <tbody>
                {detail.sightings.map((sighting) => (
                  <tr key={sighting.id}>
                    <td className="small">{sighting.sourceName}</td>
                    <td className="small">
                      <SourceUrl
                        url={sighting.sourceUrl}
                        browsable={sighting.browsable}
                        label={shortUrl(sighting.sourceUrl, 64)}
                      />
                    </td>
                    <td className="num">{sighting.timesSeen}</td>
                    <td className="num small muted nowrap">{formatDate(sighting.firstSeenAt)}</td>
                    <td className="num small muted nowrap">{formatDate(sighting.lastScrapedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Dokazi za klasifikaciju">
            {classification == null ? (
              <p className="muted">
                Nema sačuvanih dokaza — lead je označen kao{' '}
                <ClassificationBadge value={lead.classification} /> bez zapisanog obrazloženja.
              </p>
            ) : (
              <>
                <p style={{ marginTop: 0 }}>
                  <ClassificationBadge value={lead.classification} />{' '}
                  <span className="muted small">
                    pouzdanost {(lead.classificationConfidence ?? 0).toFixed(2)}
                  </span>
                  <br />
                  {classification.reason}
                </p>
                {(classification.evidence ?? []).length > 0 ? (
                  <table className="compact">
                    <thead>
                      <tr>
                        <th>Signal</th>
                        <th>Osa</th>
                        <th>Snaga</th>
                        <th>Polje</th>
                        <th>Pogodak</th>
                        <th className="num">Težina</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(classification.evidence ?? []).slice(0, 14).map((entry, index) => (
                        <tr key={`${entry.signalId}-${entry.field}-${index}`}>
                          <td className="mono small">{entry.signalId}</td>
                          <td className="small">{entry.axis}</td>
                          <td className="small">{entry.strength}</td>
                          <td className="small muted">{entry.field}</td>
                          <td className="small">„{entry.matched}”</td>
                          <td className="num small">{entry.weight.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted small">Nijedan signal se nije aktivirao.</p>
                )}
                {(classification.suppressed ?? []).length > 0 ? (
                  <>
                    <h3 style={{ marginTop: 12 }}>Namerno nije brojano</h3>
                    <ul className="plain small">
                      {(classification.suppressed ?? []).map((entry, index) => (
                        <li key={index}>
                          „{entry.matched}” je uzeo <code>{entry.claimedBy}</code>, potisnut{' '}
                          <code>{entry.suppressed}</code>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            )}
          </Panel>

          {detail.conflicts.length > 0 ? (
            <Panel title={`Sukobljene tvrdnje (${detail.conflicts.length})`}>
              <p className="small muted" style={{ marginTop: 0 }}>
                Više izvora tvrdi različite vrednosti za isto polje. Nijedna nije obrisana — jedna
                nosi <code>is_current</code>, ostale čekaju. Ispravka ispod promoviše izabranu.
              </p>
              {detail.conflicts.map((conflict) => (
                <div key={conflict.field} style={{ marginBottom: 12 }}>
                  <h3>{FIELD_LABELS[conflict.field] ?? conflict.field}</h3>
                  <table className="compact">
                    <tbody>
                      {conflict.claims.map((claim) => (
                        <tr key={claim.id}>
                          <td>
                            {claim.isCurrent ? <span className="badge good">važeća</span> : null}{' '}
                            {claim.sourceId === REVIEWER_SOURCE_ID ? (
                              <span className="badge human">čovek</span>
                            ) : null}
                          </td>
                          <td>{claim.value}</td>
                          <td className="small mono muted">{claim.sourceId}</td>
                          <td className="small">
                            <SourceUrl
                              url={claim.sourceUrl}
                              browsable={
                                /^https?:\/\//.test(claim.sourceUrl) &&
                                !claim.sourceUrl.startsWith('internal://')
                              }
                              label={shortUrl(claim.sourceUrl, 40)}
                            />
                          </td>
                          <td className="num small muted nowrap">{formatDate(claim.lastSeenAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </Panel>
          ) : null}

          <Panel title={`Istorija spajanja (${detail.mergeHistory.length})`}>
            {detail.mergeHistory.length === 0 ? (
              <p className="muted">Ovaj lead nije nastao spajanjem i nije upijao druge zapise.</p>
            ) : (
              <table className="compact">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Šta</th>
                    <th>Signal</th>
                    <th>Ko</th>
                    <th className="num">Kada</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {detail.mergeHistory.map((entry) => (
                    <tr key={entry.id}>
                      <td className="num muted">{entry.id}</td>
                      <td className="small">
                        <Link href={`/leads/${entry.mergedLeadId}`}>#{entry.mergedLeadId}</Link> →{' '}
                        <Link href={`/leads/${entry.survivingLeadId}`}>
                          #{entry.survivingLeadId}
                        </Link>
                      </td>
                      <td className="small">
                        <span className="badge">{entry.signal}</span>{' '}
                        <span className="mono muted">{entry.signalValue}</span>
                      </td>
                      <td className="small">
                        {entry.actor.startsWith('reviewer:') ? (
                          <span className="badge human">{entry.actor}</span>
                        ) : (
                          <span className="mono muted">{entry.actor}</span>
                        )}
                      </td>
                      <td className="num small muted nowrap">{formatDateTime(entry.mergedAt)}</td>
                      <td>
                        {entry.revertedAt == null ? (
                          <form action={undoMergeAction}>
                            <input type="hidden" name="mergeLogId" value={entry.id} />
                            <button className="danger" type="submit">
                              Poništi spajanje
                            </button>
                          </form>
                        ) : (
                          <span className="badge bad">
                            poništeno {formatDate(entry.revertedAt)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        <div>
          <Panel title="Odluka">
            <StatusForm leadId={lead.id} status={lead.status} action={setStatusAction} />
            {lead.reviewNote ? (
              <p className="small" style={{ marginBottom: 0 }}>
                <span className="muted">Poslednja beleška:</span> {lead.reviewNote}
              </p>
            ) : null}
            <p className="small muted" style={{ marginBottom: 0 }}>
              Status i beleška su jedine kolone koje nijedan crawl ne dira — ni{' '}
              <code>upsertLead</code> ni <code>applyGrading</code>. Odluka zapisana ovde je sigurna
              po konstrukciji. Šema nema status <code>contacted</code>; „pozvali smo ih” se beleži
              kao <em>Odobreno</em> uz datiranu belešku.
            </p>
          </Panel>

          <Panel title="Podaci">
            <dl className="kv">
              <dt>Naziv</dt>
              <dd>
                {lead.name}{' '}
                {editedFields.has('name') ? <span className="badge human">čovek</span> : null}
              </dd>
              <dt>Ključ za dedup</dt>
              <dd className="mono small muted">{lead.nameNormalized}</dd>
              <dt>Adresa</dt>
              <dd>
                {lead.address ?? '—'}{' '}
                {editedFields.has('address') ? <span className="badge human">čovek</span> : null}
              </dd>
              <dt>Grad (objavljen)</dt>
              <dd>{lead.cityRaw ?? '—'}</dd>
              <dt>Opština</dt>
              <dd>
                {municipality ? (
                  <Link href={`/leads?opstina=${municipality.id}`}>{municipality.name_sr}</Link>
                ) : (
                  <span className="muted">nije prepoznata</span>
                )}
              </dd>
              <dt>Poštanski broj</dt>
              <dd>{lead.postalCode ?? '—'}</dd>
              <dt>Matični broj</dt>
              <dd className="mono">{lead.registrationNumber ?? '—'}</dd>
              <dt>PIB</dt>
              <dd className="mono">{lead.taxId ?? '—'}</dd>
              <dt>Pravna forma</dt>
              <dd>{lead.legalForm ?? '—'}</dd>
              <dt>Koordinate</dt>
              <dd className="mono small">
                {lead.latitude != null && lead.longitude != null
                  ? `${lead.latitude.toFixed(5)}, ${lead.longitude.toFixed(5)}`
                  : '—'}
              </dd>
              <dt>Prvi put viđen</dt>
              <dd>{formatDateTime(lead.firstSeenAt)}</dd>
              <dt>Poslednji crawl</dt>
              <dd>{formatDateTime(lead.lastScrapedAt)}</dd>
              <dt>Pregledao čovek</dt>
              <dd>{formatDateTime(lead.reviewedAt)}</dd>
            </dl>
          </Panel>

          <Panel title="Skor po komponentama">
            {scoreComponents.length === 0 ? (
              <p className="muted">
                Skor <Score value={lead.leadScore} /> nema sačuvanu razradu.
              </p>
            ) : (
              <>
                <p style={{ marginTop: 0 }}>
                  <Score value={lead.leadScore} />{' '}
                  <span className="muted small">
                    popunjenost i relevantnost podataka, ne verovatnoća prodaje
                    {scoreCapped ? ' · ograničeno jer nema telefona' : ''}
                  </span>
                </p>
                <table className="compact">
                  <tbody>
                    {scoreComponents.map((component) => (
                      <tr key={component.id}>
                        <td className="small">{component.detail}</td>
                        <td className="num small nowrap">
                          {component.points > 0 ? '+' : ''}
                          {component.points} / {component.max}
                        </td>
                        <td style={{ width: 70 }}>
                          <div className="bar">
                            <span
                              style={{
                                width: `${Math.max(0, Math.min(100, (component.points / Math.max(component.max, 1)) * 100))}%`,
                              }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Panel>

          <Panel title="Ispravka podataka">
            <p className="small muted" style={{ marginTop: 0 }}>
              Ispravljena vrednost se upisuje kao tvrdnja izvora <code>{REVIEWER_SOURCE_ID}</code> i
              promoviše na lead. Stara vrednost se ne briše, a naredni crawl je ne može vratiti —{' '}
              <code>upsertLead</code> popunjava prazno, nikad ne gazi popunjeno.
            </p>
            <EditableFields
              leadId={lead.id}
              action={editFieldAction}
              current={{
                name: lead.name,
                address: lead.address,
                city: lead.cityRaw,
                classification: lead.classification,
                postal_code: lead.postalCode,
                registration_number: lead.registrationNumber,
                tax_id: lead.taxId,
                legal_form: lead.legalForm,
              }}
              classificationOptions={Object.entries(CLASSIFICATION_LABELS)}
            />
            {edits.length > 0 ? (
              <>
                <h3 style={{ marginTop: 12 }}>Ljudske izmene ({edits.length})</h3>
                <ul className="plain small">
                  {edits.map((claim) => (
                    <li key={claim.id}>
                      <strong>{FIELD_LABELS[claim.field] ?? claim.field}</strong> → „{claim.value}”{' '}
                      {claim.isCurrent ? (
                        <span className="badge good">važeća</span>
                      ) : (
                        <span className="badge">zamenjena</span>
                      )}
                      <span className="muted"> · {formatDate(claim.firstSeenAt)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Panel>

          {detail.suggestions.length > 0 ? (
            <Panel title={`Predlozi obogaćivanja (${detail.suggestions.length})`}>
              <ul className="plain small">
                {detail.suggestions.map((suggestion) => (
                  <li key={suggestion.id}>
                    <span className="badge">{suggestion.kind}</span>{' '}
                    <span className="mono">{suggestion.value}</span>{' '}
                    <span className="badge">{suggestion.status}</span>
                    <div className="muted">{suggestion.reason}</div>
                  </li>
                ))}
              </ul>
              <Link className="button" href="/suggestions">
                Otvori red predloga
              </Link>
            </Panel>
          ) : null}

          <Panel title={`Sve tvrdnje o poljima (${detail.fieldClaims.length})`}>
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              <table className="compact">
                <tbody>
                  {detail.fieldClaims.map((claim) => (
                    <tr key={claim.id}>
                      <td className="small muted nowrap">
                        {FIELD_LABELS[claim.field] ?? claim.field}
                      </td>
                      <td className="small">{claim.value}</td>
                      <td className="small">
                        {claim.isCurrent ? <span className="badge good">✓</span> : null}
                      </td>
                      <td className="small mono muted">{claim.sourceId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Broj izvora">
            <p style={{ margin: 0 }}>
              <strong className="num">{formatNumber(detail.sourceCount)}</strong> nezavisnih izvora
              je videlo ovaj posao na <strong className="num">{detail.sightings.length}</strong>{' '}
              različitih URL-ova. Ovo hrani i skor i pouzdanost spajanja.
            </p>
          </Panel>
        </div>
      </div>
    </main>
  );
}

export const dynamic = 'force-dynamic';
