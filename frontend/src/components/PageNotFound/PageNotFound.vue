<template>
  <div
    class="tw:flex tw:flex-col tw:items-center tw:justify-center tw:gap-2 tw:p-8"
  >
    <h1 class="tw:text-2xl tw:font-semibold">
      {{ $t("navigation.pageNotFound") }}
    </h1>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";

export default defineComponent({
  name: "PageNotFound"
});
</script>
