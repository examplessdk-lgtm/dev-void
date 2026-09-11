import cx from '../../lib/cx.tsx';

export type PerformanceBarData = Readonly<{
  isPrimary?: boolean;
  name: string;
  percentage: number;
  time: string;
}>;

type PerformanceBarProps = Readonly<{
  backgroundImage?: string;
  data: PerformanceBarData;
  large?: boolean;
}>;

export default function PerformanceBar({
  backgroundImage,
  data,
  large = false,
}: PerformanceBarProps) {
  const isPrimary = data.isPrimary ?? false;

  return (
    <div className="flex w-full items-center gap-3">
      <p
        className={cx(
          'w-24 shrink-0 font-mono text-xs tracking-wide uppercase md:w-36',
          !isPrimary && 'text-grey',
        )}
      >
        {data.name}
      </p>
      <div
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={data.percentage}
        className={cx('bg-slate relative w-full overflow-hidden squircle', large ? 'h-6' : 'h-3')}
        role="progressbar"
      >
        <div
          className={cx(
            'indicator ease-[cubic-bezier(0.65, 0, 0.35, 1)] relative block h-full overflow-hidden squircle bg-cover bg-center transition-transform duration-[660ms]',
            isPrimary ? 'bg-wine' : 'bg-grey',
          )}
          style={{
            backgroundImage: isPrimary && backgroundImage ? `url(${backgroundImage})` : undefined,
            width: `${data.percentage}%`,
          }}
        />
      </div>
      <p
        className={cx(
          'shrink-0 font-mono text-xs tracking-wide uppercase',
          !isPrimary && 'text-grey',
        )}
      >
        / {data.time}
      </p>
    </div>
  );
}
