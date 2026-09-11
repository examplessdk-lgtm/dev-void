import Stack, { VStack } from '@nkzw/stack';
import { Badge } from '@voidcloud/ui';
import type { Props } from './settings.server.ts';

export default function SettingsPage({ user }: Props) {
  return (
    <main className="bg-white dark:bg-primary">
      <section className="wrapper wrapper--ticks border-t bg-white px-10 py-8 dark:bg-primary">
        <VStack gap={8}>
          <Stack alignCenter gap={12} wrap>
            <h2 className="text-3xl text-primary dark:text-white">Settings</h2>
          </Stack>
        </VStack>
      </section>
      <section className="wrapper wrapper--ticks border-t bg-white dark:bg-primary">
        <VStack gap={12} padding={20}>
          <section className="squircle border p-4 dark:border-nickel">
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <VStack className="min-w-0" gap={8}>
                <code className="squircle w-fit max-w-full truncate bg-beige p-1 dark:bg-slate">
                  {user.login}
                </code>
                <span className="text-sm text-grey">{user.email ?? 'No email address'}</span>
              </VStack>
              <Stack alignCenter gap={8} wrap>
                <Badge
                  className="border-stroke bg-white text-grey uppercase dark:border-nickel dark:bg-primary dark:text-white"
                  variant="outline"
                >
                  {user.provider}
                </Badge>
                <Badge
                  className="border-stroke bg-white text-grey uppercase dark:border-nickel dark:bg-primary dark:text-white"
                  variant="outline"
                >
                  {user.role}
                </Badge>
              </Stack>
            </div>
          </section>
          <div className="grid gap-3 md:grid-cols-2">
            <AccountDetail label="Login" value={user.login} />
            <AccountDetail label="Email" value={user.email ?? '-'} />
            <AccountDetail label="Provider" value={user.provider} />
            <AccountDetail label="Role" value={user.role} />
          </div>
        </VStack>
      </section>
    </main>
  );
}

function AccountDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="squircle border p-4 dark:border-nickel">
      <VStack className="min-w-0" gap={8}>
        <span className="text-xs text-grey uppercase">{label}</span>
        <span className="min-w-0 truncate text-sm text-primary dark:text-white">{value}</span>
      </VStack>
    </div>
  );
}
