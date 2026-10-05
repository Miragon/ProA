<template>
  <div class="tw:flex tw:min-h-screen tw:flex-col">
    <DefaultBar />

    <DefaultView />

    <Toaster rich-colors close-button />
  </div>
</template>

<script lang="ts" setup>
import DefaultBar from "./AppBar.vue";
import DefaultView from "./View.vue";
import { Toaster } from "@/components/ui/sonner";
</script>
