<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { AvatarRoot } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <AvatarRoot
    data-slot="avatar"
    :class="
      cn(
        'tw:relative tw:flex tw:size-8 tw:shrink-0 tw:overflow-hidden tw:rounded-full',
        props.class
      )
    "
  >
    <slot />
  </AvatarRoot>
</template>
