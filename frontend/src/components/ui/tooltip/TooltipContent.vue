<script setup lang="ts">
import type { TooltipContentEmits, TooltipContentProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import {
  TooltipArrow,
  TooltipContent,
  TooltipPortal,
  useForwardPropsEmits
} from "reka-ui";
import { cn } from "@/lib/utils";

defineOptions({
  inheritAttrs: false
});

const props = withDefaults(
  defineProps<TooltipContentProps & { class?: HTMLAttributes["class"] }>(),
  {
    sideOffset: 4
  }
);

const emits = defineEmits<TooltipContentEmits>();

const delegatedProps = reactiveOmit(props, "class");
const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <TooltipPortal>
    <TooltipContent
      data-slot="tooltip-content"
      v-bind="{ ...forwarded, ...$attrs }"
      :class="
        cn(
          'tw:bg-foreground tw:text-background tw:animate-in tw:fade-in-0 tw:zoom-in-95 tw:data-[state=closed]:animate-out tw:data-[state=closed]:fade-out-0 tw:data-[state=closed]:zoom-out-95 tw:data-[side=bottom]:slide-in-from-top-2 tw:data-[side=left]:slide-in-from-right-2 tw:data-[side=right]:slide-in-from-left-2 tw:data-[side=top]:slide-in-from-bottom-2 tw:z-[2400] tw:w-fit tw:rounded-md tw:px-3 tw:py-1.5 tw:text-xs tw:text-balance',
          props.class
        )
      "
    >
      <slot />

      <TooltipArrow
        class="tw:bg-foreground tw:fill-foreground tw:z-[2400] tw:size-2.5 tw:translate-y-[calc(-50%_-_2px)] tw:rotate-45 tw:rounded-xs"
      />
    </TooltipContent>
  </TooltipPortal>
</template>
