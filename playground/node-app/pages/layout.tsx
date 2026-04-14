import { Link } from '@void/react';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav>
        <Link href="/" prefetch>
          Home
        </Link>{' '}
        |{' '}
        <Link href="/about" prefetch>
          About
        </Link>
      </nav>
      <hr />
      {children}
    </div>
  );
}
