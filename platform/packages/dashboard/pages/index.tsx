import Stack, { VStack } from '@nkzw/stack';
import type { Props } from './index.server.ts';

export default function AuthenticatedPage({ user }: Props) {
  return (
    <main className="bg-white dark:bg-primary">
      <section className="wrapper wrapper--ticks border-t bg-white px-10 py-12 dark:bg-primary">
        <VStack gap={20}>
          <VStack gap={8}>
            <h1 className="text-3xl text-primary dark:text-white">You’re signed in.</h1>
            <p className="text-grey">
              Authenticated as{' '}
              <strong className="text-primary dark:text-white">{user.login}</strong>.
            </p>
          </VStack>
          <Stack>
            <a className="button" href="/account">
              Manage login methods
            </a>
            <a className="button" href="/logout">
              Sign out
            </a>
          </Stack>
        </VStack>
      </section>
    </main>
  );
}
