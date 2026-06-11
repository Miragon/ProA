<template>
  <div
    class="tw:bg-background tw:text-foreground tw:flex tw:min-h-screen tw:w-full tw:flex-col tw:items-center tw:justify-center tw:gap-4 tw:p-4"
  >
    <template v-if="error">
      <p class="tw:text-destructive tw:text-sm">
        {{ $t("authentication.signInCallbackFailed") }}
      </p>
      <Button type="button" @click="retry">
        {{ $t("authentication.retry") }}
      </Button>
    </template>
    <template v-else>
      <LoaderCircle
        class="tw:text-muted-foreground tw:size-6 tw:animate-spin"
      />
      <p class="tw:text-muted-foreground tw:text-sm">
        {{ $t("authentication.redirectingToLogin") }}
      </p>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { LoaderCircle } from "@lucide/vue";
import { Button } from "@/components/ui/button";

const router = useRouter();
const error = ref(false);

onMounted(async () => {
  try {
    // Lazy import: desktop mode must never load the OIDC machinery.
    const { handleSigninCallback } = await import("@/auth/oidc");
    await handleSigninCallback();
    await router.replace({ path: "/", state: { showLoggedInBanner: true } });
  } catch {
    error.value = true;
  }
});

const retry = async () => {
  error.value = false;
  try {
    const { signinRedirect } = await import("@/auth/oidc");
    await signinRedirect();
  } catch {
    error.value = true;
  }
};
</script>
