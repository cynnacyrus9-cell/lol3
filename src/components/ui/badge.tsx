import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide', {
  variants: {
    variant: {
      default: 'border-line-strong bg-raised text-ink-2',
      accent: 'border-accent/30 bg-accent-soft text-accent',
      good: 'border-good/30 bg-good/10 text-[#4ee39a]',
      warning: 'border-warning/30 bg-warning/10 text-warning',
      critical: 'border-critical/40 bg-critical/10 text-[#ff7b7b]',
      outline: 'border-line-strong text-muted',
    },
  },
  defaultVariants: { variant: 'default' },
})

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
