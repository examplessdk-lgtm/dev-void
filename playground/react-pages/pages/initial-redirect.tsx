import { useRouter } from '@void/react';
import { useLayoutEffect } from 'react';
import type { Props } from './initial-redirect.server';

export default function InitialRedirectPage({ title }: Props) {
  const router = useRouter();

  useLayoutEffect(() => {
    router.visit('/users');
  }, [router]);

  return (
    <div>
      <h1>{title}</h1>
    </div>
  );
}
