import { useEffect, useMemo, useState } from 'react';
import oxcMonoIcon from '../../assets/icons/oxc-mono.svg';
import rolldownMonoIcon from '../../assets/icons/rolldown-mono.svg';
import viteMonoIcon from '../../assets/icons/vite-mono.svg';
import viteplusMonoIcon from '../../assets/icons/viteplus-mono.svg';
import vitestMonoIcon from '../../assets/icons/vitest-mono.svg';
import { useThemeContext } from '../../context/ThemeContext.tsx';
import type { BannerConfig } from '../../types/theme-config.ts';

type TopBannerProps = Readonly<{
  banner?: BannerConfig;
  isMarketingPage?: boolean;
}>;

type BannerIcon = NonNullable<BannerConfig['icon']>;

const variantIcons: Record<BannerIcon, { alt: string; src: string }> = {
  oxc: { alt: 'Oxc', src: oxcMonoIcon },
  rolldown: { alt: 'Rolldown', src: rolldownMonoIcon },
  vite: { alt: 'Vite', src: viteMonoIcon },
  viteplus: { alt: 'Vite+', src: viteplusMonoIcon },
  vitest: { alt: 'Vitest', src: vitestMonoIcon },
};

export default function TopBanner({ banner, isMarketingPage = false }: TopBannerProps) {
  const { footerBg: backgroundImage, logoAlt, monoIcon } = useThemeContext();

  const [dismissed, setDismissed] = useState(() => {
    if (!banner?.id) {
      return false;
    }
    return localStorage.getItem(`banner-dismissed-${banner.id}`) === 'true';
  });

  useEffect(() => {
    if (!banner?.id) {
      return;
    }

    if (dismissed) {
      document.documentElement.classList.add('banner-dismissed');
    } else {
      document.documentElement.classList.remove('banner-dismissed');
    }

    return () => {
      document.documentElement.classList.remove('banner-dismissed');
    };
  }, [banner?.id, dismissed]);

  const showBanner = Boolean(banner?.text && banner?.url) && !dismissed;

  const linkTarget = useMemo(() => {
    if (banner?.target) {
      return banner.target;
    }
    const url = banner?.url || '';
    return url.startsWith('http') ? '_blank' : '_self';
  }, [banner?.target, banner?.url]);

  const linkRel = linkTarget === '_blank' ? 'noopener noreferrer' : undefined;
  const bannerIcon = banner?.icon ? variantIcons[banner.icon] : { alt: logoAlt, src: monoIcon };

  const dismiss = () => {
    document.documentElement.classList.add('banner-dismissed');
    setDismissed(true);
    if (banner?.id) {
      localStorage.setItem(`banner-dismissed-${banner.id}`, 'true');
    }
  };

  if (!showBanner) {
    return null;
  }

  return (
    <div
      className={
        isMarketingPage
          ? 'top-banner relative hidden w-full overflow-hidden md:block'
          : 'top-banner relative hidden w-full overflow-hidden md:block lg:fixed lg:top-0 lg:right-0 lg:left-0 lg:z-60'
      }
      data-theme="dark"
    >
      <a
        className="group relative block w-full text-white no-underline"
        href={banner?.url || '#'}
        rel={linkRel}
        target={linkTarget}
      >
        <img
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover object-bottom brightness-60"
          loading="eager"
          src={backgroundImage}
        />

        <div className="relative z-10 flex h-10 w-full px-4">
          <div className="mx-auto flex w-full max-w-360 items-center gap-2 px-4">
            <img
              alt={`${bannerIcon.alt} icon`}
              className="hidden h-5 w-5 shrink-0 -translate-y-px drop-shadow-md/70 sm:block"
              src={bannerIcon.src}
            />

            <span className="translate-y-px overflow-hidden font-mono text-xs leading-snug font-medium tracking-wide text-ellipsis whitespace-nowrap uppercase text-shadow-md/50">
              {banner?.text}
            </span>

            <svg
              aria-hidden="true"
              className="shrink-0 transition-transform duration-200 group-hover:translate-x-1"
              fill="none"
              height="20"
              viewBox="0 0 20 20"
              width="20"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect fill="#08060D" height="20" rx="4" width="20" />
              <rect
                height="19"
                rx="3.5"
                stroke="white"
                strokeOpacity="0.15"
                width="19"
                x="0.5"
                y="0.5"
              />
              <path d="M10 6L14 10L10 14" stroke="white" strokeLinejoin="round" strokeWidth="1.2" />
              <path d="M14 10L6 10" stroke="white" strokeLinejoin="round" strokeWidth="1.2" />
            </svg>
          </div>
        </div>
      </a>
      <button
        aria-label="Close banner"
        className="absolute top-1/2 right-2 z-20 -translate-y-1/2 p-2 text-white transition-opacity hover:opacity-70"
        onClick={dismiss}
        type="button"
      >
        <svg
          aria-hidden="true"
          className="mt-px cursor-pointer"
          fill="none"
          height="20"
          stroke="currentColor"
          viewBox="0 0 24 24"
          width="20"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M6 18L18 6M6 6l12 12"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
          />
        </svg>
      </button>
    </div>
  );
}
