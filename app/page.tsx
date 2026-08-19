const PLACEHOLDER_STATS = [
  { label: 'Leads', value: '—' },
  { label: 'Unique phones', value: '—' },
  { label: 'Cities covered', value: '—' },
  { label: 'Duplicates merged', value: '—' },
] as const;

export default function DashboardPage() {
  return (
    <main>
      <h1>Serbia Facade Lead Engine</h1>
      <p className="subtitle">
        Lead review dashboard — facade contractors and construction-material stores.
      </p>

      <section className="stats">
        {PLACEHOLDER_STATS.map((stat) => (
          <div className="stat" key={stat.label}>
            <div className="stat-label">{stat.label}</div>
            <div className="stat-value">{stat.value}</div>
          </div>
        ))}
      </section>

      <p className="note">
        Placeholder dashboard. The database schema, the lead list and the XLSX export land in the
        Stage 2 issues; until then this page renders no data. Run a scrape with{' '}
        <code>npm run scrape</code>.
      </p>
    </main>
  );
}
