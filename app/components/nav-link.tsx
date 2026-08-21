'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * A nav item that knows whether it is the current page.
 *
 * The only client component in the shell — everything else is rendered on the
 * server, and `better-sqlite3` must never reach a client import graph.
 */
export function NavLink({
  href,
  children,
  match = 'exact',
}: {
  href: string;
  children: ReactNode;
  match?: 'exact' | 'startsWith';
}) {
  const pathname = usePathname();
  const active = match === 'exact' ? pathname === href : pathname.startsWith(href);
  return (
    <Link href={href} aria-current={active ? 'page' : undefined}>
      {children}
    </Link>
  );
}
