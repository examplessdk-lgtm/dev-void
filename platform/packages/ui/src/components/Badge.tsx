import { HTMLAttributes } from 'react';
import cx from '../lib/cx.tsx';

type BadgeVariant = 'default' | 'destructive' | 'outline' | 'secondary';

const badgeVariants: Record<BadgeVariant, string> = {
  default: 'border-transparent bg-primary text-white hover:bg-primary/80',
  destructive: 'border-transparent bg-fire text-white hover:bg-fire/80',
  outline: 'text-primary dark:text-white',
  secondary:
    'border-transparent bg-beige text-primary hover:bg-beige/80 dark:bg-slate dark:text-white',
};

export type BadgeProps = HTMLAttributes<HTMLDivElement> & {
  variant?: BadgeVariant;
};

function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <div
      className={cx(
        'inline-flex items-center squircle border px-1.5 pt-0.5 pb-0 text-xs font-semibold transition-colors focus:ring-2 focus:ring-offset-2 focus:outline-none',
        badgeVariants[variant],
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
