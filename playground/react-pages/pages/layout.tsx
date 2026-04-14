import { Link, useShared } from '@void/react';

export default function Layout({ children }: { children: React.ReactNode }) {
  const shared = useShared();
  return (
    <div>
      <nav>
        <Link href="/" prefetch>
          Home
        </Link>{' '}
        |{' '}
        <Link href="/users" prefetch>
          Users
        </Link>{' '}
        |{' '}
        <Link href="/blog" prefetch>
          Blog
        </Link>{' '}
        |{' '}
        <Link href="/deferred" prefetch>
          Deferred
        </Link>{' '}
        | <span>{shared.appName}</span>
      </nav>
      <hr />
      {children}
    </div>
  );
}
