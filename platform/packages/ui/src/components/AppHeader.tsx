import { Menu } from '@base-ui/react/menu';
import { Icon } from '@iconify/react';
import { useEffect, useState } from 'react';
import { useThemeContext } from '../context/ThemeContext.tsx';
import cx from '../lib/cx.tsx';
import type { IconOption } from '../types/theme-config.ts';

const EXTERNAL_URL_RE = /^(?:[a-z]+:|\/\/)/i;

type HeaderActionItem = Readonly<{
  icon?: IconOption;
  link: string;
  text: string;
}>;

type AppHeaderProps = Readonly<{
  accountMenuItems?: ReadonlyArray<HeaderActionItem>;
  accountMenuLabel?: string;
  backHref?: string;
  homeHref?: string;
  title?: string;
}>;

const isExternalLink = (link: string) => EXTERNAL_URL_RE.test(link);

const resolveIcon = (icon: IconOption | undefined, isDark: boolean) => {
  if (!icon) {
    return undefined;
  }
  return typeof icon === 'string' ? icon : isDark ? icon.dark : icon.light;
};

function NavIcon({
  className = 'size-[1em] shrink-0',
  icon,
  isDark,
}: {
  className?: string;
  icon?: IconOption;
  isDark: boolean;
}) {
  const iconName = resolveIcon(icon, isDark);
  return iconName ? <Icon aria-hidden="true" className={className} icon={iconName} /> : null;
}

export default function AppHeader({
  accountMenuItems = [],
  accountMenuLabel = 'Account',
  backHref,
  homeHref = '/',
  title,
}: AppHeaderProps) {
  const { logoAlt, logoDark, logoLight } = useThemeContext();
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const updateIsDark = () => {
      setIsDark(
        document.documentElement.classList.contains('dark') ||
          document.documentElement.dataset.theme === 'dark' ||
          mediaQuery.matches,
      );
    };
    const observer = new MutationObserver(updateIsDark);

    updateIsDark();
    mediaQuery.addEventListener('change', updateIsDark);
    observer.observe(document.documentElement, {
      attributeFilter: ['class', 'data-theme'],
      attributes: true,
    });

    return () => {
      mediaQuery.removeEventListener('change', updateIsDark);
      observer.disconnect();
    };
  }, []);

  return (
    <header className="wrapper relative flex items-center justify-between px-6 py-7">
      <div className="relative flex h-11 items-center gap-2 px-2 py-1">
        <a className="flex items-center gap-2" href={backHref ?? homeHref}>
          <div className="relative -ml-6 flex h-6 w-6 items-center justify-center">
            {backHref ? (
              <Icon
                aria-hidden="true"
                className="size-6 transition-opacity hover:opacity-50"
                icon="lucide:chevron-left"
              />
            ) : null}
          </div>
          <picture>
            <source media="(prefers-color-scheme: dark)" srcSet={logoLight} />
            <img
              alt={logoAlt}
              className="block h-4 w-auto"
              src={logoDark}
              style={{ height: '1rem', width: 'auto' }}
            />
          </picture>
        </a>
      </div>

      {accountMenuItems.length ? (
        <Menu.Root modal={false}>
          <div className="relative flex w-56 max-w-[calc(100vw-10rem)] justify-end">
            <Menu.Trigger
              aria-label={accountMenuLabel}
              className="inline-grid max-w-full min-w-0 cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-center gap-1.5 text-left text-primary transition-opacity hover:opacity-70 dark:text-white"
              title={accountMenuLabel}
            >
              <span className="flex size-4 items-center justify-center">
                <Icon aria-hidden="true" className="size-4" icon="lucide:circle-user-round" />
              </span>
              <span className="min-w-0 truncate">{accountMenuLabel}</span>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner
                align="end"
                className="z-50"
                collisionPadding={16}
                side="bottom"
                sideOffset={6}
              >
                <Menu.Popup className="min-w-40 border border-stroke bg-white p-1 shadow-md dark:border-nickel dark:bg-primary">
                  {accountMenuItems.map((item) => (
                    <Menu.LinkItem
                      className="grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-primary transition-colors [corner-shape:squircle] hover:bg-primary/5 focus:bg-primary/5 focus:outline-none dark:text-white dark:hover:bg-white/10 dark:focus:bg-white/10"
                      closeOnClick
                      href={item.link}
                      key={item.link}
                      rel={isExternalLink(item.link) ? 'noreferrer' : undefined}
                      target={isExternalLink(item.link) ? '_blank' : undefined}
                    >
                      <span className="flex size-4 items-center justify-center">
                        <NavIcon className="size-4" icon={item.icon} isDark={isDark} />
                      </span>
                      <span>{item.text}</span>
                    </Menu.LinkItem>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </div>
        </Menu.Root>
      ) : (
        <div className="h-11 w-11" />
      )}

      {title ? (
        <div className="pointer-events-none absolute top-1/2 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 sm:block">
          <h2 className={cx('text-center text-xl sm:text-2xl')}>{title}</h2>
        </div>
      ) : null}
    </header>
  );
}
