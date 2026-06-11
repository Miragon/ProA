<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <div
    data-slot="alert-description"
    :class="
      cn(
        'tw:text-muted-foreground tw:col-start-2 tw:text-sm tw:[&_p]:leading-relaxed',
        props.class
      )
    "
  >
    <slot />
  </div>
</template>
