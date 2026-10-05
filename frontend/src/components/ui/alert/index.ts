import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

export { default as Alert } from "./Alert.vue";
export { default as AlertDescription } from "./AlertDescription.vue";
export { default as AlertTitle } from "./AlertTitle.vue";

export const alertVariants = cva(
  "tw:relative tw:w-full tw:rounded-lg tw:border tw:px-4 tw:py-3 tw:text-sm tw:grid tw:has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] tw:grid-cols-[0_1fr] tw:has-[>svg]:gap-x-3 tw:gap-y-0.5 tw:items-start tw:[&>svg]:size-4 tw:[&>svg]:translate-y-0.5 tw:[&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "tw:bg-card tw:text-card-foreground",
        destructive:
          "tw:text-destructive tw:bg-card tw:[&>svg]:text-current tw:*:data-[slot=alert-description]:text-destructive/90"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);

export type AlertVariants = VariantProps<typeof alertVariants>;
