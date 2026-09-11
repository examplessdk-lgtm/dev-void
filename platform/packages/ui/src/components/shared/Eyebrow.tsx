import cx from '../../lib/cx.tsx';

export type EyebrowProps = Readonly<{
  ticks?: boolean;
  title: string;
}>;

export default function Eyebrow({ ticks = true, title }: EyebrowProps) {
  return (
    <section className={cx('wrapper border-t p-5 md:pl-10', ticks && 'wrapper--ticks')}>
      <span className="font-mono text-xs font-medium tracking-wide text-nickel uppercase dark:text-white">
        {title}
      </span>
    </section>
  );
}
