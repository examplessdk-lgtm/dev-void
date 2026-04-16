import { Link, useNavigation } from '@void/react';
import { useEffect } from 'react';
import type { Props } from './link-behavior.server';

export default function LinkBehaviorPage({ title }: Props) {
  useEffect(() => {
    (window as any).__hashNavigationStarts = 0;
    (window as any).__hashNavigationEnds = 0;
    (window as any).__hashNavigationReady = true;
  }, []);

  const navigation = useNavigation(
    () => {
      (window as any).__hashNavigationStarts = ((window as any).__hashNavigationStarts ?? 0) + 1;
    },
    () => {
      (window as any).__hashNavigationEnds = ((window as any).__hashNavigationEnds ?? 0) + 1;
    },
  );

  return (
    <div>
      <h1>{title}</h1>

      <p>
        <Link
          href="/users"
          data-testid="onclick-link"
          onClick={() => {
            (window as any).__linkOnClick = true;
          }}
        >
          User handler then SPA
        </Link>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="prevented-click-link"
          onClick={(event) => {
            event.preventDefault();
            (window as any).__preventedClick = true;
          }}
        >
          Prevented click
        </Link>
      </p>

      <p>
        <Link
          href="/users"
          data-testid="prevented-navigate-link"
          onNavigate={(event) => {
            event.preventDefault();
            (window as any).__preventedNavigate = true;
          }}
        >
          Prevented navigate
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="replace-link" replace>
          Replace with users
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="reload-link" reloadDocument>
          Reload document
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="blank-link" target="_blank">
          Open users in a new tab
        </Link>
      </p>

      <p>
        <Link href="/users" data-testid="download-link" download="users.html">
          Download users
        </Link>
      </p>

      <p>
        <Link
          href="/link-behavior"
          data={{
            tag: ['a', 'b'],
            page: 2,
            active: true,
            skip: null,
            missing: undefined,
          }}
          data-testid="query-data-link"
        >
          Query data
        </Link>
      </p>

      <p>
        <Link href="#hash-target" data-testid="hash-link">
          Hash target
        </Link>
      </p>

      <p>
        <a href="#plain-hash-target" data-testid="plain-hash-link">
          Plain hash target
        </a>
      </p>

      <p data-testid="navigation-location">{navigation.location}</p>
      <p data-testid="navigation-pending">{navigation.pendingLocation ?? ''}</p>

      <section id="hash-target">
        <h2>Hash target</h2>
      </section>

      <section id="plain-hash-target">
        <h2>Plain hash target</h2>
      </section>
    </div>
  );
}
