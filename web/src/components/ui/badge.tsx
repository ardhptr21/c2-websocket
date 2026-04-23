import type { HTMLAttributes } from 'react';

import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide',
  {
    variants: {
      variant: {
        default: 'border-border bg-muted text-foreground',
        success: 'border-emerald-300 bg-emerald-100 text-emerald-800',
        warning: 'border-amber-300 bg-amber-100 text-amber-800',
        destructive: 'border-rose-300 bg-rose-100 text-rose-800',
        secondary: 'border-zinc-300 bg-zinc-100 text-zinc-800',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) {
  return <div data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
