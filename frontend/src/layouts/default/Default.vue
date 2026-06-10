<template>
  <v-app>
    <default-bar />

    <default-view />

    <v-snackbar
      v-model="store.snackbar.visible"
      :color="store.snackbar.color"
      :timeout="store.snackbar.timeout"
    >
      <v-icon left large class="snackbar-icon">
        {{ store.snackbar.icon }}
      </v-icon>
      <span class="snackbar-text">{{ store.snackbar.message }}</span>
    </v-snackbar>
  </v-app>
</template>

<script lang="ts" setup>
import DefaultBar from "./AppBar.vue";
import DefaultView from "./View.vue";
import { useAppStore } from "@/store/app";

const store = useAppStore();
</script>

<style scoped>
@import "@/styles/global.css";
</style>
