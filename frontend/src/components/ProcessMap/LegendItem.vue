<template>
  <div class="tw:flex tw:flex-row tw:items-center tw:px-2 tw:py-1.5">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      :width="width"
      :height="height"
      :viewBox="viewBox"
    >
      <path :d="path" stroke="#000" :stroke-width="strokeWidth" fill="none" />
    </svg>
    <p class="tw:ml-4">{{ text }}</p>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";

export default defineComponent({
  name: "LegendItem",
  props: {
    path: { type: String, required: true },
    viewBox: { type: String, required: true },
    text: { type: String, required: true },
    width: { type: String, required: true },
    height: { type: String, required: true },
    strokeWidth: { type: String, default: "5" }
  }
});
</script>
