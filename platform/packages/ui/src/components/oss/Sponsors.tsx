import { useMemo } from 'react';
import viteByVoidzero from '../../assets/vite/vite-by-voidzero.png';
import cx from '../../lib/cx.tsx';
import type { SponsorSize, SponsorTier } from '../../types/sponsors.ts';

type SponsorsProps = Readonly<{
  description?: string;
  heading?: string;
  logoStyle?: 'opencollective';
  sideBySideTiers?: [string, string];
  sponsorLink?: string;
  sponsorLinkText?: string;
  sponsors?: ReadonlyArray<SponsorTier>;
}>;

const sizeConfig: Record<
  SponsorSize,
  { avatarMode?: boolean; columns: number; logoSize: string; padding: string }
> = {
  avatar: {
    avatarMode: true,
    columns: 15,
    logoSize: 'w-10 h-10',
    padding: 'py-3',
  },
  big: { columns: 3, logoSize: 'h-13 w-[220px]', padding: 'py-16' },
  medium: { columns: 5, logoSize: 'h-8 w-[120px]', padding: 'py-7' },
  small: { columns: 7, logoSize: 'h-6 w-[100px]', padding: 'py-5' },
};

const gridClasses: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
  5: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5',
  6: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6',
  7: 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-7',
};

const getEffectiveColumns = (size: SponsorSize, itemCount: number) =>
  Math.min(sizeConfig[size].columns, itemCount);

const getGridColumns = (size: SponsorSize, itemCount: number) =>
  gridClasses[getEffectiveColumns(size, itemCount)] || 'grid-cols-1';

const getEmptyCells = (itemCount: number, size: SponsorSize) => {
  const cols = getEffectiveColumns(size, itemCount);
  const remainder = itemCount % cols;
  return remainder === 0 ? 0 : cols - remainder;
};

const getBackerEmptySlots = (itemCount: number, minSlots = 30) => {
  const targetSlots = Math.max(itemCount, minSlots);
  return Math.max(0, targetSlots - itemCount);
};

export default function Sponsors({
  description = 'Vite is MIT Licensed and will always be free and open source. This is made possible by our contributors and these companies:',
  heading = 'Free & open source',
  logoStyle,
  sideBySideTiers,
  sponsorLink = 'https://github.com/sponsors/vitejs',
  sponsorLinkText = 'Become a Sponsor',
  sponsors,
}: SponsorsProps) {
  const sideBySideData = useMemo(() => {
    if (!sponsors || !sideBySideTiers) {
      return null;
    }

    const [leftTierName, rightTierName] = sideBySideTiers;
    const leftTier = sponsors.find(
      (tier) => tier.tier.toLowerCase() === leftTierName.toLowerCase(),
    );
    const rightTier = sponsors.find(
      (tier) => tier.tier.toLowerCase() === rightTierName.toLowerCase(),
    );

    if (!leftTier || !rightTier) {
      return null;
    }

    return { left: leftTier, right: rightTier };
  }, [sideBySideTiers, sponsors]);

  const stackedSponsors = useMemo(() => {
    if (!sponsors) {
      return [];
    }
    if (!sideBySideTiers) {
      return sponsors;
    }

    const sideBySideNames = sideBySideTiers.map((name) => name.toLowerCase());
    return sponsors.filter((tier) => !sideBySideNames.includes(tier.tier.toLowerCase()));
  }, [sideBySideTiers, sponsors]);

  return (
    <>
      <div className="wrapper wrapper--ticks border-t px-10 py-14 sm:py-30">
        <div className="flex flex-col items-center justify-between gap-8 text-center md:flex-row md:gap-20 md:pl-15 md:text-left">
          <div className="flex flex-col gap-3">
            <h3 className="max-w-xl text-balance">{heading}</h3>
            <p className="max-w-lg text-balance text-grey dark:text-white/70">{description}</p>
            <a
              className="button mx-auto mt-8 w-fit md:mx-0"
              href={sponsorLink}
              rel="noopener noreferrer"
              target="_blank"
            >
              {sponsorLinkText}
            </a>
          </div>
          <a
            className="flex items-start justify-center gap-8 md:justify-start md:gap-12 md:pr-25"
            href="https://voidzero.dev"
            rel="noopener noreferrer"
            target="_blank"
          >
            <img
              alt="Brought to you by VoidZero"
              className="mt-10 h-44 max-w-full object-contain md:mt-0"
              src={viteByVoidzero}
            />
          </a>
        </div>
      </div>
      {sponsors && sponsors.length > 0 ? (
        <div className={cx('wrapper', logoStyle === 'opencollective' && 'sponsor-style-oc')}>
          {stackedSponsors.map((tier, tierIndex) => (
            <div
              className={cx('border-stroke dark:border-nickel', tierIndex === 0 && 'border-t')}
              key={`${tier.tier}-${tierIndex}`}
            >
              <div className="border-b border-stroke px-5 py-5 sm:px-10 dark:border-nickel">
                <span className="font-mono text-xs tracking-wide text-grey uppercase dark:text-white/70">
                  {tier.tier}
                </span>
              </div>

              {sizeConfig[tier.size].avatarMode ? (
                <div className="backers-grid px-5 py-6 sm:px-10">
                  {tier.items.map((sponsor, index) => (
                    <a
                      className="backer-avatar group relative"
                      href={sponsor.url}
                      key={`${sponsor.url}-${index}`}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <img
                        alt={sponsor.name}
                        className="h-10 w-10 squircle border border-stroke object-cover transition-all group-hover:scale-110 group-hover:border-nickel/40 dark:border-nickel dark:group-hover:border-white/50"
                        src={sponsor.img}
                      />
                      <span className="backer-tooltip">{sponsor.name}</span>
                    </a>
                  ))}
                  {Array.from({
                    length: getBackerEmptySlots(tier.items.length),
                  }).map((_, index) => (
                    <div
                      aria-hidden="true"
                      className="backer-avatar-placeholder"
                      key={`empty-${index}`}
                    >
                      <div className="h-10 w-10 squircle border border-stroke/30 dark:border-nickel/30"></div>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className={cx(
                    '[&>*]:border-stroke dark:[&>*]:border-nickel grid [&>*]:border-r [&>*]:border-b',
                    getGridColumns(tier.size, tier.items.length),
                  )}
                >
                  {tier.items.map((sponsor, index) => (
                    <a
                      className={cx(
                        'sponsor-link flex items-center justify-center px-8 opacity-85 transition-opacity hover:opacity-100',
                        sizeConfig[tier.size].padding,
                      )}
                      href={sponsor.url}
                      key={`${sponsor.url}-${index}`}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <img
                        alt={sponsor.name}
                        className={cx(
                          'sponsor-logo object-contain',
                          sizeConfig[tier.size].logoSize,
                        )}
                        src={sponsor.img}
                      />
                      <span className="sponsor-name ml-5">{sponsor.name}</span>
                    </a>
                  ))}
                  {Array.from({
                    length: getEmptyCells(tier.items.length, tier.size),
                  }).map((_, index) => (
                    <div
                      aria-hidden="true"
                      className={cx(
                        'sponsor-link flex items-center justify-center px-8',
                        sizeConfig[tier.size].padding,
                      )}
                      key={`empty-${index}`}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}

          {sideBySideData ? (
            <div className="grid grid-cols-1 border-t border-stroke lg:grid-cols-2 dark:border-nickel">
              <div className="border-b border-stroke lg:border-r lg:border-b-0 dark:border-nickel">
                <div className="border-b border-stroke px-5 py-5 sm:px-10 dark:border-nickel">
                  <span className="font-mono text-xs tracking-wide text-grey uppercase dark:text-white/70">
                    {sideBySideData.left.tier}
                  </span>
                </div>
                <div className="flex flex-col">
                  {sideBySideData.left.items.map((sponsor, index) => (
                    <a
                      className="sponsor-link flex items-center justify-center border-b border-stroke px-8 py-12 opacity-85 transition-opacity last:border-b-0 hover:opacity-100 dark:border-nickel"
                      href={sponsor.url}
                      key={`${sponsor.url}-${index}`}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <img
                        alt={sponsor.name}
                        className={cx(
                          'sponsor-logo object-contain',
                          sizeConfig[sideBySideData.left.size].logoSize,
                        )}
                        src={sponsor.img}
                      />
                      <span className="sponsor-name ml-5">{sponsor.name}</span>
                    </a>
                  ))}
                </div>
              </div>

              <div>
                <div className="border-b border-stroke px-5 py-5 sm:px-10 dark:border-nickel">
                  <span className="font-mono text-xs tracking-wide text-grey uppercase dark:text-white/70">
                    {sideBySideData.right.tier}
                  </span>
                </div>
                {sizeConfig[sideBySideData.right.size].avatarMode ? (
                  <div className="backers-grid px-5 py-6 sm:px-10">
                    {sideBySideData.right.items.map((sponsor, index) => (
                      <a
                        className="backer-avatar group relative"
                        href={sponsor.url}
                        key={`${sponsor.url}-${index}`}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        <img
                          alt={sponsor.name}
                          className="h-10 w-10 squircle border border-stroke object-cover transition-all group-hover:scale-110 group-hover:border-nickel/40 dark:border-nickel dark:group-hover:border-white/50"
                          src={sponsor.img}
                        />
                        <span className="backer-tooltip">{sponsor.name}</span>
                      </a>
                    ))}
                    {Array.from({
                      length: getBackerEmptySlots(sideBySideData.right.items.length),
                    }).map((_, index) => (
                      <div
                        aria-hidden="true"
                        className="backer-avatar-placeholder"
                        key={`empty-${index}`}
                      >
                        <div className="h-10 w-10 squircle border border-stroke/30 dark:border-nickel/30"></div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    className={cx(
                      '[&>*]:border-stroke dark:[&>*]:border-nickel grid [&>*]:border-r [&>*]:border-b',
                      getGridColumns(sideBySideData.right.size, sideBySideData.right.items.length),
                    )}
                  >
                    {sideBySideData.right.items.map((sponsor, index) => (
                      <a
                        className={cx(
                          'sponsor-link flex items-center justify-center px-8 opacity-85 transition-opacity hover:opacity-100',
                          sizeConfig[sideBySideData.right.size].padding,
                        )}
                        href={sponsor.url}
                        key={`${sponsor.url}-${index}`}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        <img
                          alt={sponsor.name}
                          className={cx(
                            'sponsor-logo object-contain',
                            sizeConfig[sideBySideData.right.size].logoSize,
                          )}
                          src={sponsor.img}
                        />
                        <span className="sponsor-name ml-5">{sponsor.name}</span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
