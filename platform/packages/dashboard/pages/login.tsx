import Stack, { VStack } from '@nkzw/stack';
import { AppHeader, FooterNav, ThemeContextProvider } from '@voidcloud/ui';
import heroBackground from '@voidcloud/ui/assets/hero-background.jpg';
import monoIcon from '@voidcloud/ui/assets/icons/void-icon.svg';
import logoDark from '@voidcloud/ui/assets/logos/void-dark.svg';
import logoLight from '@voidcloud/ui/assets/logos/void-light.svg';
import footerBg from '@voidcloud/ui/assets/vite/footer-background.jpg';
import type { ReactNode } from 'react';
import type { Props } from './login.server.ts';

function FlexibleSpacer() {
  return (
    <Stack
      aria-hidden="true"
      as="section"
      className="wrapper wrapper--ticks min-h-12 w-full border-t"
      flex1
    />
  );
}

const footerConfig = {
  nav: [
    {
      items: [
        { link: 'https://void.cloud/', text: 'Void Cloud' },
        { link: 'https://voidzero.dev/', text: 'VoidZero' },
      ],
      title: 'COMPANY',
    },
  ],
  social: [
    { icon: 'github', link: 'https://github.com/voidzero-dev' },
    { icon: 'bluesky', link: 'https://bsky.app/profile/voidzero.dev' },
    { icon: 'discord', link: 'https://discord.gg/cC6TEVFKSx' },
    { icon: 'x', link: 'https://x.com/voidzerodev' },
  ],
};

function LoginPageShell({ children }: { children: ReactNode }) {
  return (
    <ThemeContextProvider
      value={{
        footerBg,
        logoAlt: 'Void',
        logoDark,
        logoLight,
        monoIcon,
      }}
    >
      <div className="login-public-shell marketing-layout flex min-h-screen flex-col bg-white text-primary dark:bg-primary dark:text-white">
        <AppHeader />
        <main className="login-public-main flex flex-1 flex-col">
          <section className="login-public-hero wrapper wrapper--ticks grid w-full divide-x divide-stroke border-t border-stroke md:grid-cols-2 dark:divide-nickel dark:border-nickel">
            <VStack center className="login-public-copy items-center p-5 md:items-start">
              <VStack
                className="login-public-copy-inner max-w-[30rem] items-center text-center md:items-start md:text-left"
                gap={20}
              >
                {children}
              </VStack>
            </VStack>
            <VStack className="login-public-art-column min-h-[9rem] sm:min-h-[18rem]">
              <VStack
                center
                className="login-public-art relative h-full overflow-clip bg-cover bg-center py-8 pl-6 sm:py-16 sm:pl-16"
                style={{ backgroundImage: `url(${heroBackground})` }}
              />
            </VStack>
          </section>
          <FlexibleSpacer />
        </main>
        <FooterNav footer={footerConfig} />
      </div>
    </ThemeContextProvider>
  );
}

export default function LoginPage({ githubUrl, googleUrl, devLoginUrl }: Props) {
  return (
    <LoginPageShell>
      <h1 className="max-w-[25rem] text-pretty">Sign in to Void.</h1>
      <Stack alignCenter className="mt-8 sm:!flex-row" gap={20} vertical>
        <a className="button button--primary text-white! hover:text-white!" href={githubUrl}>
          <span className="text-white">Continue with GitHub</span>
        </a>
        <a className="button" href={googleUrl}>
          Continue with Google
        </a>
      </Stack>
      {devLoginUrl && (
        <div className="mt-4">
          <a className="button" href={devLoginUrl}>
            Dev login (local API)
          </a>
          <p className="mt-2 text-sm text-secondary">
            Local-development bypass. Requires <code>DEV_AUTH_BYPASS=true</code> on the API.
          </p>
        </div>
      )}
    </LoginPageShell>
  );
}
