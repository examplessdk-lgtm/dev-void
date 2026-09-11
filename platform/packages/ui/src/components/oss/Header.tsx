import { Icon } from '@iconify/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useThemeContext } from '../../context/ThemeContext.tsx';
import cx from '../../lib/cx.tsx';
import type { IconOption } from '../../types/theme-config.ts';

const EXTERNAL_URL_RE = /^(?:[a-z]+:|\/\/)/i;

type NavItem = Readonly<{
  icon?: IconOption;
  items?: ReadonlyArray<NavGroupItem>;
  link?: string;
  text: string;
}>;

type NavGroupItem =
  | {
      icon?: IconOption;
      link: string;
      text: string;
    }
  | {
      icon?: IconOption;
      items: ReadonlyArray<{ icon?: IconOption; link: string; text: string }>;
      text?: string;
    };

type LocaleLink = Readonly<{
  link: string;
  text: string;
}>;

type CurrentLang = Readonly<{
  label?: string;
}>;

type HeaderActionItem = Readonly<{
  icon?: IconOption;
  link: string;
  text: string;
}>;

type HeaderSocialLink = Readonly<{
  icon: string;
  label?: string;
  link: string;
}>;

type HeaderProps = Readonly<{
  accountMenuItems?: ReadonlyArray<HeaderActionItem>;
  accountMenuLabel?: string;
  currentLang?: CurrentLang;
  currentPath?: string;
  isForcedTheme?: boolean;
  isMarketingPage?: boolean;
  isSearchAvailable?: boolean;
  langMenuLabel?: string;
  localeLinks?: ReadonlyArray<LocaleLink>;
  nav?: ReadonlyArray<NavItem>;
  navBarTitleAfter?: ReactNode;
  navBarTitleBefore?: ReactNode;
  socialLinks?: ReadonlyArray<HeaderSocialLink>;
}>;

const isDropdown = (item: NavItem) => Boolean(item.items && Array.isArray(item.items));

const isExternalLink = (link: string) => EXTERNAL_URL_RE.test(link);

const normalizeLink = (link: string) => link;

const socialIconName = (icon: string) => `simple-icons:${icon}`;

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

export default function Header({
  accountMenuItems = [],
  accountMenuLabel = 'Account',
  currentLang,
  currentPath = '',
  isForcedTheme = false,
  isMarketingPage = false,
  isSearchAvailable = false,
  langMenuLabel = 'Language',
  localeLinks = [],
  nav = [],
  navBarTitleAfter,
  navBarTitleBefore,
  socialLinks = [
    { icon: 'github', label: 'GitHub', link: 'https://github.com/voidzero-dev' },
    { icon: 'bluesky', label: 'Bluesky', link: 'https://bsky.app/profile/voidzero.dev' },
    { icon: 'x', label: 'X', link: 'https://x.com/voidzerodev' },
  ],
}: HeaderProps) {
  const { logoAlt, logoDark, logoLight } = useThemeContext();
  const [isDark, setIsDark] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [expandedAccordions, setExpandedAccordions] = useState<Set<number>>(new Set());
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const focusTrapRef = useRef<{
    firstFocusableEl: HTMLElement | null;
    lastFocusableEl: HTMLElement | null;
  }>({ firstFocusableEl: null, lastFocusableEl: null });

  const toggleAccordion = useCallback((index: number) => {
    setExpandedAccordions((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const handleKeydown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape' && mobileMenuOpen) {
        setMobileMenuOpen(false);
      }
    },
    [mobileMenuOpen],
  );

  const lockBodyScroll = useCallback(() => {
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
    document.body.style.top = '0';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
  }, []);

  const unlockBodyScroll = useCallback(() => {
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.width = '';
    document.body.style.top = '';
    document.body.style.paddingRight = '';
  }, []);

  const closeMobileMenu = useCallback(() => {
    setMobileMenuOpen(false);
    setAccountMenuOpen(false);
    setExpandedAccordions(new Set());
    setLanguageMenuOpen(false);
    unlockBodyScroll();
  }, [unlockBodyScroll]);

  const toggleMobileMenu = useCallback(() => {
    setMobileMenuOpen((prev) => {
      const next = !prev;
      if (next) {
        lockBodyScroll();
      } else {
        unlockBodyScroll();
      }
      return next;
    });
  }, [lockBodyScroll, unlockBodyScroll]);

  const triggerSearch = useCallback(() => {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      code: 'KeyK',
      ctrlKey: true,
      key: 'k',
      metaKey: true,
    });
    window.dispatchEvent(event);
  }, []);

  const activateFocusTrap = useCallback(() => {
    const mobileMenu = document.getElementById('mobile-menu');
    if (!mobileMenu) {
      return;
    }

    const focusableElements = mobileMenu.querySelectorAll(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );

    if (focusableElements.length === 0) {
      return;
    }

    const focusableArray = Array.from(focusableElements);
    focusTrapRef.current.firstFocusableEl = focusableArray[0] as HTMLElement;
    focusTrapRef.current.lastFocusableEl = focusableArray.at(-1) as HTMLElement;

    focusTrapRef.current.firstFocusableEl?.focus();

    const handleTabKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') {
        return;
      }

      if (event.shiftKey) {
        if (document.activeElement === focusTrapRef.current.firstFocusableEl) {
          focusTrapRef.current.lastFocusableEl?.focus();
          event.preventDefault();
        }
      } else {
        if (document.activeElement === focusTrapRef.current.lastFocusableEl) {
          focusTrapRef.current.firstFocusableEl?.focus();
          event.preventDefault();
        }
      }
    };

    document.addEventListener('keydown', handleTabKey);

    return () => {
      document.removeEventListener('keydown', handleTabKey);
    };
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('keydown', handleKeydown);
      unlockBodyScroll();
    };
  }, [handleKeydown, unlockBodyScroll]);

  useEffect(() => {
    if (!accountMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        accountMenuRef.current &&
        event.target instanceof Node &&
        !accountMenuRef.current.contains(event.target)
      ) {
        setAccountMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [accountMenuOpen]);

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

  useEffect(() => {
    if (mobileMenuOpen) {
      const cleanup = activateFocusTrap();
      return () => cleanup?.();
    }
    return undefined;
  }, [activateFocusTrap, mobileMenuOpen]);

  const desktopNav = useMemo(
    () =>
      nav.map((item) => (
        <li key={item.text}>
          {item.link ? (
            <a
              className="flex items-center gap-1 font-sans text-base"
              href={normalizeLink(item.link)}
            >
              <NavIcon icon={item.icon} isDark={isDark} />
              {item.text}
            </a>
          ) : (
            <span className="flex items-center gap-1 font-sans text-base">
              <NavIcon icon={item.icon} isDark={isDark} />
              {item.text}
            </span>
          )}
        </li>
      )),
    [isDark, nav],
  );

  return (
    <div
      className={
        isMarketingPage
          ? 'relative z-50 w-full'
          : 'relative z-50 w-full lg:fixed lg:top-[var(--banner-height,0)] lg:right-0 lg:left-0'
      }
    >
      <header className="wrapper relative flex items-center justify-between border-b border-stroke bg-white px-6 py-5 dark:border-nickel dark:bg-primary">
        <div className="flex gap-10 self-stretch">
          <a className="-mx-2 flex flex-col items-start justify-center px-2" href="/">
            {navBarTitleBefore}
            <img alt={logoAlt} className="block h-4 dark:hidden" src={logoDark} />
            <img alt={logoAlt} className="hidden h-4 dark:block" src={logoLight} />
            {navBarTitleAfter}
          </a>

          <div className="hidden items-center gap-4 lg:flex">
            <ul className="nav">{desktopNav}</ul>
          </div>
        </div>

        <div className="flex items-center gap-2 lg:gap-4">
          {isSearchAvailable ? (
            <div className="hidden items-center lg:flex">
              <button aria-label="Search" className="button" onClick={triggerSearch} type="button">
                Search
              </button>
            </div>
          ) : null}

          <div className="hidden items-center gap-4 lg:flex">
            {!isForcedTheme ? (
              <button className="button" type="button">
                Appearance
              </button>
            ) : null}
            {accountMenuItems.length ? (
              <div className="relative" ref={accountMenuRef}>
                <button
                  aria-label={accountMenuLabel}
                  aria-expanded={accountMenuOpen}
                  aria-haspopup="menu"
                  className="flex max-w-56 min-w-0 cursor-pointer items-center gap-2 px-2 py-2 font-sans text-sm text-primary transition-opacity hover:opacity-70 dark:text-white"
                  onClick={() => setAccountMenuOpen((value) => !value)}
                  title={accountMenuLabel}
                  type="button"
                >
                  <Icon
                    aria-hidden="true"
                    className="size-4 shrink-0"
                    icon="lucide:circle-user-round"
                  />
                  <span className="min-w-0 truncate">{accountMenuLabel}</span>
                </button>
                {accountMenuOpen ? (
                  <div
                    className="absolute top-full right-0 z-50 mt-1 min-w-40 border border-stroke bg-white p-1 shadow-md dark:border-nickel dark:bg-primary"
                    role="menu"
                  >
                    {accountMenuItems.map((item) => (
                      <a
                        className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-primary transition-colors [corner-shape:squircle] hover:bg-primary/5 dark:text-white dark:hover:bg-white/10"
                        href={normalizeLink(item.link)}
                        key={item.link}
                        onClick={() => setAccountMenuOpen(false)}
                        rel={isExternalLink(item.link) ? 'noreferrer' : undefined}
                        role="menuitem"
                        target={isExternalLink(item.link) ? '_blank' : undefined}
                      >
                        <NavIcon className="size-4 shrink-0" icon={item.icon} isDark={isDark} />
                        {item.text}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : currentLang?.label ? (
              <button className="button" type="button">
                {currentLang.label}
              </button>
            ) : null}
            {socialLinks.length ? (
              <div className="flex items-center gap-3">
                {socialLinks.map((social) => (
                  <a
                    aria-label={social.label || social.icon}
                    className="transition-opacity hover:opacity-70"
                    href={social.link}
                    key={social.link}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-[18px]"
                      icon={socialIconName(social.icon)}
                    />
                  </a>
                ))}
              </div>
            ) : null}
          </div>

          {isSearchAvailable ? (
            <button
              aria-label="Search"
              className="cursor-pointer p-2 transition-opacity hover:opacity-70 lg:hidden"
              onClick={triggerSearch}
              type="button"
            >
              <Icon aria-hidden="true" className="size-5" icon="lucide:search" />
            </button>
          ) : null}

          <button
            aria-controls="mobile-menu"
            aria-expanded={mobileMenuOpen}
            aria-label="Toggle navigation menu"
            className="-mr-2 cursor-pointer p-2 transition-opacity hover:opacity-70 lg:hidden"
            onClick={toggleMobileMenu}
            type="button"
          >
            {!mobileMenuOpen ? (
              <>
                <svg
                  className="block size-6 dark:hidden"
                  viewBox="0 0 18 8"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M0 0.75H18" stroke="#08060D" strokeWidth="1.5" />
                  <path d="M0 6.75H18" stroke="#08060D" strokeWidth="1.5" />
                </svg>
                <svg
                  className="hidden size-6 dark:block"
                  viewBox="0 0 18 8"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path d="M0 0.75H18" stroke="#FFFFFF" strokeWidth="1.5" />
                  <path d="M0 6.75H18" stroke="#FFFFFF" strokeWidth="1.5" />
                </svg>
              </>
            ) : null}
          </button>
        </div>
      </header>

      <div className="wrapper tick-left tick-right relative h-0"></div>

      {mobileMenuOpen ? (
        <div
          aria-label="Mobile navigation menu"
          aria-modal="true"
          className="fixed inset-0 z-[1001] bg-white lg:hidden dark:bg-primary"
          id="mobile-menu"
          role="dialog"
        >
          <section className="wrapper animate-fade-in">
            <div className="flex w-full items-center justify-between py-5 pr-5 pl-5 lg:py-7">
              <a href="/">
                <img alt={logoAlt} className="block h-4 dark:hidden" src={logoDark} />
                <img alt={logoAlt} className="hidden h-4 dark:block" src={logoLight} />
              </a>
              <div className="flex items-center gap-2">
                {isSearchAvailable ? (
                  <button
                    aria-label="Search"
                    className="cursor-pointer p-2 transition-opacity hover:opacity-70"
                    onClick={triggerSearch}
                    type="button"
                  >
                    <Icon aria-hidden="true" className="size-5" icon="lucide:search" />
                  </button>
                ) : null}
                <button
                  aria-label="Close navigation menu"
                  className="-mr-2 p-2 transition-opacity hover:opacity-70"
                  onClick={closeMobileMenu}
                  type="button"
                >
                  <Icon aria-hidden="true" className="size-6 cursor-pointer" icon="lucide:x" />
                </button>
              </div>
            </div>

            <div
              className="flex flex-col overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              style={{ height: 'calc(100vh - 88px)' }}
            >
              <nav className="w-full flex-1 pt-6 pb-8">
                <ul className="space-y-1">
                  {nav.map((navItem, index) => (
                    <li key={navItem.text}>
                      {isDropdown(navItem) ? (
                        <>
                          <button
                            aria-expanded={expandedAccordions.has(index)}
                            className="flex w-full items-center justify-between px-4 py-3 font-sans text-base"
                            onClick={() => toggleAccordion(index)}
                          >
                            <span className="flex items-center gap-1">
                              <NavIcon icon={navItem.icon} isDark={isDark} />
                              {navItem.text}
                            </span>
                            <Icon
                              aria-hidden="true"
                              className={cx(
                                'size-4 transition-transform duration-200',
                                expandedAccordions.has(index) && 'rotate-180',
                              )}
                              icon="lucide:chevron-down"
                            />
                          </button>
                          <ul
                            className="space-y-1 pl-4"
                            style={{
                              display: expandedAccordions.has(index) ? 'block' : 'none',
                            }}
                          >
                            {navItem.items?.map((childItem, childIndex) => {
                              if ('link' in childItem) {
                                return (
                                  <li key={`${childItem.link}-${childIndex}`}>
                                    <a
                                      className={cx(
                                        'text-grey hover:text-primary flex items-center gap-1 px-4 py-1.5 font-sans text-sm dark:text-white/80 dark:hover:text-white',
                                        currentPath === normalizeLink(childItem.link) &&
                                          'bg-primary/10 dark:bg-white/10',
                                      )}
                                      href={normalizeLink(childItem.link)}
                                      onClick={closeMobileMenu}
                                      rel={
                                        isExternalLink(childItem.link) ? 'noreferrer' : undefined
                                      }
                                      target={isExternalLink(childItem.link) ? '_blank' : undefined}
                                    >
                                      <NavIcon icon={childItem.icon} isDark={isDark} />
                                      {childItem.text}
                                    </a>
                                  </li>
                                );
                              }

                              return (
                                <li key={`${childItem.text || 'group'}-${childIndex}`}>
                                  {childItem.text ? (
                                    <p className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wider text-grey/70 uppercase dark:text-white/50">
                                      {childItem.text}
                                    </p>
                                  ) : null}
                                  <ul className="space-y-1 pl-4">
                                    {childItem.items.map((nestedItem) => (
                                      <li key={nestedItem.link}>
                                        <a
                                          className={cx(
                                            'text-grey hover:text-primary flex items-center gap-1 px-4 py-1.5 font-sans text-sm dark:text-white/80 dark:hover:text-white',
                                            currentPath === normalizeLink(nestedItem.link) &&
                                              'bg-primary/10 dark:bg-white/10',
                                          )}
                                          href={normalizeLink(nestedItem.link)}
                                          onClick={closeMobileMenu}
                                          rel={
                                            isExternalLink(nestedItem.link)
                                              ? 'noreferrer'
                                              : undefined
                                          }
                                          target={
                                            isExternalLink(nestedItem.link) ? '_blank' : undefined
                                          }
                                        >
                                          <NavIcon icon={nestedItem.icon} isDark={isDark} />
                                          {nestedItem.text}
                                        </a>
                                      </li>
                                    ))}
                                  </ul>
                                </li>
                              );
                            })}
                          </ul>
                        </>
                      ) : navItem.link ? (
                        <a
                          className={cx(
                            'flex items-center gap-1 px-4 py-3 font-sans text-base',
                            currentPath === normalizeLink(navItem.link) &&
                              'bg-primary/10 dark:bg-white/10',
                          )}
                          href={normalizeLink(navItem.link)}
                          onClick={closeMobileMenu}
                          rel={isExternalLink(navItem.link) ? 'noreferrer' : undefined}
                          target={isExternalLink(navItem.link) ? '_blank' : undefined}
                        >
                          <NavIcon icon={navItem.icon} isDark={isDark} />
                          {navItem.text}
                        </a>
                      ) : (
                        <span className="flex items-center gap-1 px-4 py-3 font-sans text-base">
                          <NavIcon icon={navItem.icon} isDark={isDark} />
                          {navItem.text}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>

              <div className="tick-left tick-right relative mt-auto w-full border-t border-stroke pt-6 pb-12 dark:border-nickel">
                <div className="space-y-6">
                  {accountMenuItems.length ? (
                    <div className="px-4">
                      <p className="pb-2 text-xs font-semibold tracking-wider text-grey/70 uppercase dark:text-white/50">
                        {accountMenuLabel}
                      </p>
                      <ul className="space-y-1">
                        {accountMenuItems.map((item) => (
                          <li key={item.link}>
                            <a
                              className="flex items-center gap-2 py-2 text-sm transition-opacity hover:opacity-70"
                              href={normalizeLink(item.link)}
                              onClick={closeMobileMenu}
                              rel={isExternalLink(item.link) ? 'noreferrer' : undefined}
                              target={isExternalLink(item.link) ? '_blank' : undefined}
                            >
                              <NavIcon
                                className="size-4 shrink-0"
                                icon={item.icon}
                                isDark={isDark}
                              />
                              {item.text}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {localeLinks.length && currentLang?.label ? (
                    <div className="px-4">
                      <button
                        aria-expanded={languageMenuOpen}
                        className="flex w-full items-center justify-between text-sm font-medium text-grey dark:text-white/80"
                        onClick={() => setLanguageMenuOpen((prev) => !prev)}
                      >
                        <span>{langMenuLabel}</span>
                        <Icon
                          aria-hidden="true"
                          className={cx(
                            'size-4 transition-transform duration-200',
                            languageMenuOpen && 'rotate-180',
                          )}
                          icon="lucide:chevron-down"
                        />
                      </button>
                      <ul
                        className="mt-3 space-y-1"
                        style={{
                          display: languageMenuOpen ? 'block' : 'none',
                        }}
                      >
                        {localeLinks.map((locale) => (
                          <li key={locale.link}>
                            <a
                              className="block py-2 text-sm transition-opacity hover:opacity-70"
                              href={locale.link}
                              onClick={closeMobileMenu}
                            >
                              {locale.text}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {!isForcedTheme ? (
                    <div className="flex items-center justify-between px-4">
                      <span className="text-sm font-medium text-grey dark:text-white/80">
                        Appearance
                      </span>
                      <button className="button" type="button">
                        Toggle
                      </button>
                    </div>
                  ) : null}

                  {socialLinks.length ? (
                    <div className="flex items-center justify-center gap-4 pt-4">
                      {socialLinks.map((social) => (
                        <a
                          aria-label={social.label || social.icon}
                          className="transition-opacity hover:opacity-70"
                          href={social.link}
                          key={social.link}
                          onClick={closeMobileMenu}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          <Icon
                            aria-hidden="true"
                            className="size-[18px]"
                            icon={socialIconName(social.icon)}
                          />
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
