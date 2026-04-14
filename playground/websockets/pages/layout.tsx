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
        <Link href="/chat" prefetch>
          Chat
        </Link>{' '}
        |{' '}
        <Link href="/notifications" prefetch>
          Notifications
        </Link>{' '}
        | <span>{shared.appName}</span>
      </nav>
      <hr />
      {children}
    </div>
  );
}
