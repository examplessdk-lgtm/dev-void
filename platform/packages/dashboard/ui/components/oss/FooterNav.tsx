import { Icon } from '@iconify/react';
import type {
  FooterColumn,
  FooterConfig,
  FooterLink,
  FooterSocialLink,
} from '../../types/theme-config.ts';

type FooterNavProps = Readonly<{
  footer?: FooterConfig;
}>;

const socialIconName = (icon: string) => {
  const key = icon.toLowerCase();
  return key === 'twitter' || key === 'x' ? 'simple-icons:x' : `simple-icons:${key}`;
};

const socialLabelMap: Record<string, string> = {
  bluesky: 'Bluesky',
  discord: 'Discord',
  github: 'GitHub',
  twitter: 'X.com',
  x: 'X.com',
};

const getSocialLabel = (social: FooterSocialLink) =>
  social.label ? social.label : socialLabelMap[social.icon.toLowerCase()] || social.icon;

export default function FooterNav({ footer }: FooterNavProps) {
  const footerNav: ReadonlyArray<FooterColumn> = footer?.nav ?? [];
  const footerSocial: ReadonlyArray<FooterSocialLink> = footer?.social ?? [];
  const footerCopyright =
    footer?.copyright || `© ${new Date().getFullYear()} VoidZero Inc. All Rights Reserved.`;

  return (
    <>
      <section className="wrapper wrapper--ticks border-t">
        <div className="flex flex-col gap-10 px-5 pt-10 pb-16 md:flex-row md:justify-between md:gap-0 md:px-24 md:pt-16 md:pb-40">
          <div className="flex flex-col gap-10 md:flex-row md:gap-20">
            {footerNav.map((column) => (
              <div key={column.title}>
                <p className="mb-8 font-mono text-xs tracking-wide text-[var(--color-text-2)] uppercase">
                  {column.title}
                </p>
                <ul className="flex flex-col gap-3">
                  {column.items.map((item: FooterLink) => (
                    <li key={item.link}>
                      <a className="text-base text-[var(--color-text-1)]" href={item.link}>
                        {item.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {footerSocial.length ? (
            <div>
              <p className="mb-8 font-mono text-xs tracking-wide text-[var(--color-text-2)] uppercase">
                Social
              </p>
              <ul className="flex flex-col gap-3">
                {footerSocial.map((social) => (
                  <li key={social.link}>
                    <a
                      className="flex items-center gap-3 text-base text-[var(--color-text-1)]"
                      href={social.link}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <Icon
                        aria-hidden="true"
                        className="size-[18px]"
                        icon={socialIconName(social.icon)}
                      />
                      {getSocialLabel(social)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>
      <section className="wrapper wrapper--ticks flex flex-col items-start justify-between gap-3 border-t px-5 py-5 md:flex-row md:items-center md:gap-0 md:px-24">
        <p className="text-sm">{footerCopyright}</p>
      </section>
    </>
  );
}
