import { Icon } from '@iconify/react';
import cx from '../../lib/cx.tsx';
import type { FeatureConfig } from '../../types/theme-config.ts';

type FeatureGridProps = Readonly<{
  appearance?: 'dark' | 'surface';
  features?: ReadonlyArray<FeatureConfig>;
}>;

export default function FeatureGrid({ appearance = 'dark', features = [] }: FeatureGridProps) {
  if (!features.length) {
    return null;
  }

  const isDark = appearance === 'dark';

  return (
    <section
      className={cx(
        'wrapper wrapper--ticks grid divide-x divide-y border-t md:grid-cols-2',
        isDark
          ? 'divide-nickel bg-primary text-white'
          : 'divide-stroke bg-white text-primary dark:divide-nickel dark:bg-primary dark:text-white',
      )}
      data-theme={isDark ? 'dark' : undefined}
    >
      {features.map((feature) => (
        <div
          className="flex flex-col justify-between gap-3 border-r-0 md:odd:border-r md:nth-last-2:border-b-0"
          key={feature.icon || feature.iconify || feature.title}
        >
          <div className="flex flex-col gap-3 px-10 py-8 sm:px-15 sm:py-12">
            <p className="text-2xl">
              {feature.iconify ? (
                <Icon aria-hidden="true" height="1em" icon={feature.iconify} width="1em" />
              ) : (
                feature.icon
              )}
            </p>
            <h5 className={cx('text-balance sm:text-pretty', isDark && 'text-white')}>
              {feature.title}
            </h5>
            {feature.details ? <p className="text-base sm:max-w-md">{feature.details}</p> : null}
          </div>
        </div>
      ))}
    </section>
  );
}
