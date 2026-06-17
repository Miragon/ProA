<template>
  <!--
    The header is a 64px (h-16) sticky bar, so the routed content fills the
    rest of the viewport. The explicit height is load-bearing: the JointJS
    process map and the bpmn-js viewers size their canvases with height: 100%
    (see .full-screen / .full-screen-below-toolbar) and need a definite height
    on their ancestor chain.
  -->
  <main class="tw:h-[calc(100vh-4rem)] tw:flex-1 tw:overflow-auto">
    <router-view />
  </main>
</template>

<script lang="ts" setup>
//
</script>
