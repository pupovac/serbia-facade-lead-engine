import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NavLink } from './components/nav-link';
import { db } from './lib/db';
import { formatNumber } from './lib/format';
import { dashboardStats } from '@/lib/review';
import './globals.css';

export const metadata: Metadata = {
  title: 'Serbia Facade Lead Engine',
  description: 'Lead review UI for facade contractors and construction-material stores in Serbia',
};

/**
 * The database is the system of record and the pages read it synchronously on
 * every request; caching a rendered page would show a reviewer the queue as it
 * was before their own decision.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  // The queue counts sit in the nav because the whole point of the two review
  // pages is that someone notices there is work waiting.
  const stats = dashboardStats(db());

  return (
    <html lang="sr-Latn">
      <body>
        <header className="topbar">
          <span className="brand">
            Fasadni leadovi<span>Srbija</span>
          </span>
          <nav className="nav">
            <NavLink href="/">Pregled</NavLink>
            <NavLink href="/leads" match="startsWith">
              Leadovi
              <span className="badge">{formatNumber(stats.totalLeads)}</span>
            </NavLink>
            <NavLink href="/merges">
              Spajanja
              {stats.reviewQueue.pendingMerges > 0 ? (
                <span className="badge warn">{formatNumber(stats.reviewQueue.pendingMerges)}</span>
              ) : null}
            </NavLink>
            <NavLink href="/suggestions">
              Predlozi
              {stats.reviewQueue.pendingSuggestions > 0 ? (
                <span className="badge warn">
                  {formatNumber(stats.reviewQueue.pendingSuggestions)}
                </span>
              ) : null}
            </NavLink>
          </nav>
          <span className="spacer" />
          <span className="small muted nowrap">
            {formatNumber(stats.withPhone)} sa telefonom · {stats.municipalitiesCovered}/
            {stats.municipalitiesTotal} opština
          </span>
        </header>
        {children}
      </body>
    </html>
  );
}
