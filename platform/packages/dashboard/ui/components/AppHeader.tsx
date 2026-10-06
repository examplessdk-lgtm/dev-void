import { Menu } from '@base-ui/react/menu';
import { Icon } from '@iconify/react';
import { useThemeContext } from '../context/ThemeContext.tsx';

const EXTERNAL_URL_RE = /^(?:[a-z]+:|\/\/)/i;

type HeaderActionItem = Readonly<{
  icon?: string;
  link: string;
  text: string;
}>;

type AppHeaderProps = Readonly<{
  accountMenuItems?: ReadonlyArray<HeaderActionItem>;
  accountMenuLabel?: string;
}>;

const isExternalLink = (link: string) => EXTERNAL_URL_RE.test(link);

export default function AppHeader({
  accountMenuItems = [],
  accountMenuLabel = 'Account',
}: AppHeaderProps) {
  const { logoAlt, logoDark, logoLight } = useThemeContext();

  return (
    <header className="wrapper relative flex items-center justify-between px-6 py-7">
      <div className="relative flex h-11 items-center gap-2 px-2 py-1">
        <a className="flex items-center gap-2" href="/">
          <div className="relative -ml-6 flex h-6 w-6 items-center justify-center" />
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
                        {item.icon ? (
                          <Icon aria-hidden="true" className="size-4" icon={item.icon} />
                        ) : null}
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
    </header>
  );
}
