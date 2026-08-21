/**
 * The dashboard — the numbers that decide what to crawl next.
 *
 * Every figure is a `group by` in `src/lib/review/dashboard.ts`. The coverage
 * table lists all 145 local self-government units including the ones with no
 * leads, because a table of what was found cannot show a gap, and gaps are what
 * the next crawl is aimed at.
 */
import Link from 'next/link';
import { dashboardStats } from '@/lib/review';
import { db, EXPORT_AVAILABLE, EXPORT_ISSUE } from './lib/db';
import { CLASSIFICATION_LABELS, formatNumber, formatPercent, shortUrl } from './lib/format';
import { Bar, Panel, Stat } from './components/ui';

export default function DashboardPage() {
  const stats = dashboardStats(db());
  const gaps = stats.coverage.filter((row) => row.leads === 0);
  const thin = stats.coverage.filter((row) => row.leads > 0 && row.leads < 5);
  const topGaps = [...gaps].sort((a, b) => b.population - a.population).slice(0, 12);

  return (
    <main>
      <div className="page-head">
        <div>
          <h1>Pregled baze</h1>
          <p className="subtitle">
            {formatNumber(stats.totalLeads)} aktivnih leadova · {formatNumber(stats.distinctPhones)}{' '}
            jedinstvenih telefona · {formatNumber(stats.tombstones)} spojenih zapisa
          </p>
        </div>
        <div className="actions">
          <Link className="button" href="/leads?phone=yes&sort=score">
            Leadovi sa telefonom
          </Link>
          <button disabled={!EXPORT_AVAILABLE} title={`XLSX izvoz stiže sa ${EXPORT_ISSUE}`}>
            {EXPORT_AVAILABLE ? 'Izvezi XLSX' : `Izvoz XLSX — čeka ${EXPORT_ISSUE}`}
          </button>
        </div>
      </div>

      <div className="stats">
        <Stat label="Leadovi" value={formatNumber(stats.totalLeads)} note="aktivni, bez spojenih" />
        <Stat
          label="Sa telefonom"
          value={formatPercent(stats.withPhone, stats.totalLeads)}
          note={`${formatNumber(stats.withPhone)} od ${formatNumber(stats.totalLeads)}`}
        />
        <Stat
          label="Bez telefona"
          value={formatNumber(stats.withoutPhone)}
          note="glavni isporučivi podatak nedostaje"
        />
        <Stat
          label="Opštine"
          value={`${stats.municipalitiesCovered}/${stats.municipalitiesTotal}`}
          note={gaps.length === 0 ? 'pokrivena cela Srbija' : `${gaps.length} bez ijednog leada`}
        />
        <Stat
          label="Sa sajtom"
          value={formatPercent(stats.withWebsite, stats.totalLeads)}
          note={`${formatNumber(stats.withWebsite)} leadova`}
        />
        <Stat
          label="Sa e-poštom"
          value={formatPercent(stats.withEmail, stats.totalLeads)}
          note={`${formatNumber(stats.withEmail)} leadova`}
        />
        <Stat
          label="Za pregled"
          value={formatNumber(stats.reviewQueue.pendingMerges)}
          note={<Link href="/merges">parova za spajanje</Link>}
        />
        <Stat
          label="Predlozi"
          value={formatNumber(stats.reviewQueue.pendingSuggestions)}
          note={<Link href="/suggestions">obogaćivanja na čekanju</Link>}
        />
      </div>

      <div className="grid two">
        <Panel title="Leadovi po tipu">
          <table className="compact">
            <thead>
              <tr>
                <th>Tip</th>
                <th className="num">Leadovi</th>
                <th className="num">Sa telefonom</th>
                <th>Udeo</th>
              </tr>
            </thead>
            <tbody>
              {stats.byClassification.map((row) => (
                <tr key={row.classification}>
                  <td>
                    <Link href={`/leads?type=${row.classification}`}>
                      {CLASSIFICATION_LABELS[row.classification] ?? row.classification}
                    </Link>
                  </td>
                  <td className="num">{formatNumber(row.leads)}</td>
                  <td className="num">
                    {formatNumber(row.withPhone)}{' '}
                    <span className="muted small">{formatPercent(row.withPhone, row.leads)}</span>
                  </td>
                  <td style={{ width: 140 }}>
                    <Bar part={row.leads} whole={stats.totalLeads} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Oznake se čitaju iz baze, ne iz fiksne liste — FUZZ-32 ponovo klasifikuje isti korpus i
            raspodela će se pomeriti.
          </p>
        </Panel>

        <Panel title="Prinos po izvoru">
          <table className="compact">
            <thead>
              <tr>
                <th>Izvor</th>
                <th className="num">Leadovi</th>
                <th className="num">Sa telefonom</th>
                <th className="num" title="Leadovi koje je video samo ovaj izvor">
                  Samo ovde
                </th>
                <th className="num">URL-ova</th>
              </tr>
            </thead>
            <tbody>
              {stats.sourceYield.map((row) => (
                <tr key={row.sourceId}>
                  <td>
                    <Link href={`/leads?izvor=${row.sourceId}`}>{row.name}</Link>
                    <div className="small muted mono">{row.sourceId}</div>
                  </td>
                  <td className="num">{formatNumber(row.leads)}</td>
                  <td className="num">{formatNumber(row.withPhone)}</td>
                  <td className="num">{formatNumber(row.exclusive)}</td>
                  <td className="num">{formatNumber(row.urls)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <div className="grid two">
        <Panel title="Rast po prolazu crawlera">
          <table className="compact">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Izvor</th>
                <th className="num">Novi</th>
                <th className="num">Ažurirani</th>
                <th className="num">Telefoni</th>
                <th className="num">Ukupno</th>
                <th style={{ width: 120 }}>Kumulativno</th>
              </tr>
            </thead>
            <tbody>
              {stats.growth.map((point) => (
                <tr key={point.runId}>
                  <td className="num muted">{point.runId}</td>
                  <td className="mono small">{point.sourceId}</td>
                  <td className="num">{formatNumber(point.leadsCreated)}</td>
                  <td className="num">{formatNumber(point.leadsUpdated)}</td>
                  <td className="num">{formatNumber(point.phonesAdded)}</td>
                  <td className="num">{formatNumber(point.cumulativeLeads)}</td>
                  <td>
                    <Bar
                      part={point.cumulativeLeads}
                      whole={stats.growth[stats.growth.length - 1]?.cumulativeLeads ?? 1}
                      tone="good"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Po prolazu, ne po danu: ceo pilot korpus je prikupljen istog dana, pa bi dnevni grafikon
            bio jedan stubić.
          </p>
        </Panel>

        <Panel title={`Rupe u pokrivenosti — ${gaps.length} opština bez leada`}>
          {gaps.length === 0 ? (
            <p className="muted">
              Svih {stats.municipalitiesTotal} opština ima bar jedan lead. Sledeća meta je dubina:{' '}
              {thin.length} opština ima manje od 5.
            </p>
          ) : (
            <table className="compact">
              <thead>
                <tr>
                  <th>Opština</th>
                  <th>Okrug</th>
                  <th className="num">Stanovnika</th>
                </tr>
              </thead>
              <tbody>
                {topGaps.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td className="muted small">{row.district}</td>
                    <td className="num">{formatNumber(row.population)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 style={{ marginTop: 14 }}>Najtanje pokrivene ({thin.length})</h3>
          <table className="compact">
            <thead>
              <tr>
                <th>Opština</th>
                <th className="num">Leadovi</th>
                <th className="num">Sa telefonom</th>
                <th className="num">Stanovnika</th>
              </tr>
            </thead>
            <tbody>
              {[...thin]
                .sort((a, b) => b.population - a.population)
                .slice(0, 10)
                .map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/leads?opstina=${row.id}`}>{row.name}</Link>
                    </td>
                    <td className="num">{row.leads}</td>
                    <td className="num">{row.withPhone}</td>
                    <td className="num">{formatNumber(row.population)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Pokrivenost po opštinama">
        <div className="table-wrap" style={{ maxHeight: 460, overflow: 'auto' }}>
          <table className="compact">
            <thead>
              <tr>
                <th>Opština</th>
                <th>Okrug</th>
                <th className="num">Leadovi</th>
                <th className="num">Sa telefonom</th>
                <th className="num">Fasaderi</th>
                <th className="num">Stovarišta</th>
                <th className="num">Stanovnika</th>
                <th className="num" title="Leadova na 10.000 stanovnika">
                  na 10k
                </th>
                <th style={{ width: 110 }}>Pokrivenost</th>
              </tr>
            </thead>
            <tbody>
              {stats.coverage.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.leads === 0 ? (
                      <span className="muted">{row.name}</span>
                    ) : (
                      <Link href={`/leads?opstina=${row.id}`}>{row.name}</Link>
                    )}
                  </td>
                  <td className="muted small">{row.district}</td>
                  <td className="num">{formatNumber(row.leads)}</td>
                  <td className="num">{formatNumber(row.withPhone)}</td>
                  <td className="num">{formatNumber(row.contractors)}</td>
                  <td className="num">{formatNumber(row.stores)}</td>
                  <td className="num muted">{formatNumber(row.population)}</td>
                  <td className="num">
                    {row.population === 0
                      ? '—'
                      : (Math.round((row.leads / row.population) * 100000) / 10).toFixed(1)}
                  </td>
                  <td>
                    <Bar
                      part={row.withPhone}
                      whole={Math.max(row.leads, 1)}
                      tone={row.leads === 0 ? 'bad' : row.withPhone === row.leads ? 'good' : 'warn'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Beogradske gradske opštine se sabiraju u <code>beograd</code>, pa imenilac ostaje{' '}
          {stats.municipalitiesTotal} jedinica lokalne samouprave iz{' '}
          <code>{shortUrl('data/serbia-geo.json')}</code>.
          {stats.unmappedGeo > 0
            ? ` ${formatNumber(stats.unmappedGeo)} leadova nema prepoznatu opštinu.`
            : ''}
        </p>
      </Panel>
    </main>
  );
}
