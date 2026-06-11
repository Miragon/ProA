<template>
  <div
    class="tw:bg-background tw:text-foreground tw:flex tw:min-h-[calc(100vh_-_var(--v-layout-top,0px))] tw:w-full tw:items-center tw:justify-center tw:p-4"
  >
    <Card class="tw:w-full tw:max-w-lg">
      <CardHeader class="tw:border-b">
        <CardTitle>{{ $t("authentication.welcomeBack") }}</CardTitle>
      </CardHeader>
      <CardContent>
        <form class="tw:flex tw:flex-col tw:gap-4" novalidate @submit.prevent>
          <Alert
            v-if="message.message !== ''"
            :variant="message.type === 'error' ? 'destructive' : 'default'"
            class="tw:pr-10"
          >
            <CircleAlert v-if="message.type === 'error'" />
            <CircleCheck v-else />
            <AlertDescription>{{ message.message }}</AlertDescription>
            <Button
              variant="ghost"
              size="icon-sm"
              class="tw:absolute tw:top-1.5 tw:right-1.5"
              type="button"
              @click="message.message = ''"
            >
              <X />
              <span class="tw:sr-only">{{ $t("general.close") }}</span>
            </Button>
          </Alert>
          <div class="tw:flex tw:flex-col tw:gap-2">
            <Label for="sign-in-email">{{ $t("authentication.email") }}</Label>
            <Input
              id="sign-in-email"
              v-model="email"
              type="email"
              autocomplete="email"
              required
              :aria-invalid="!!errors.email || undefined"
            />
            <p v-if="errors.email" class="tw:text-destructive tw:text-sm">
              {{ errors.email }}
            </p>
          </div>
          <div class="tw:flex tw:flex-col tw:gap-2">
            <Label for="sign-in-password">
              {{ $t("authentication.password") }}
            </Label>
            <Input
              id="sign-in-password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              :aria-invalid="!!errors.password || undefined"
            />
            <p v-if="errors.password" class="tw:text-destructive tw:text-sm">
              {{ errors.password }}
            </p>
          </div>
        </form>
      </CardContent>
      <CardFooter>
        <Button
          type="button"
          size="lg"
          class="tw:w-full"
          :disabled="loading"
          @click="signIn"
        >
          <LoaderCircle v-if="loading" class="tw:animate-spin" />
          {{ $t("navigation.signIn") }}
        </Button>
      </CardFooter>
    </Card>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import {
  currentPasswordRules,
  emailRulesSignIn,
  firstRuleError
} from "@/components/Authentication/formValidation";
import { AxiosError } from "axios";
import { SelectedDialog, useAppStore } from "@/store/app";
import { Message } from "@/components/Authentication/AuthenticationDialog.vue";
import { login } from "@/api/auth";
import { getCurrentUser } from "@/api/users";
import { Role } from "@/components/ProcessMap/types";
import { CircleAlert, CircleCheck, LoaderCircle, X } from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default defineComponent({
  name: "SignIn",

  components: {
    Alert,
    AlertDescription,
    Button,
    Card,
    CardContent,
    CardFooter,
    CardHeader,
    CardTitle,
    CircleAlert,
    CircleCheck,
    Input,
    Label,
    LoaderCircle,
    X
  },

  data() {
    return {
      email: "" as string,
      password: "" as string,
      errors: { email: "", password: "" },
      loading: false as boolean,
      store: useAppStore(),
      SelectedDialog: SelectedDialog,
      message: { message: "", type: "error" } as Message,
      defaultMessage: { message: "", type: "error" } as Message
    };
  },

  watch: {
    // "Reward early, punish late": only re-validate a field while typing
    // once an error is already shown, so valid input clears it immediately.
    email(value: string) {
      if (this.errors.email) {
        this.errors.email = firstRuleError(value, emailRulesSignIn);
      }
    },
    password(value: string) {
      if (this.errors.password) {
        this.errors.password = firstRuleError(value, currentPasswordRules);
      }
    }
  },

  methods: {
    validate(): boolean {
      this.errors.email = firstRuleError(this.email, emailRulesSignIn);
      this.errors.password = firstRuleError(
        this.password,
        currentPasswordRules
      );
      return !this.errors.email && !this.errors.password;
    },
    async signIn() {
      this.message = { ...this.defaultMessage };
      if (!this.validate()) {
        return;
      }

      this.loading = true;
      try {
        const token = await login(this.email, this.password);
        this.store.setUserToken(token);

        const user = await getCurrentUser();
        this.store.setUserRole(user.role as Role);

        this.$router.push({ path: "/", state: { showLoggedInBanner: true } });
      } catch (e) {
        if ((e as AxiosError).response?.status === 403) {
          this.message = {
            type: "error",
            message: this.$t("authentication.accountLocked") as string
          };
          return;
        }

        if ((e as AxiosError).response?.status === 429) {
          this.message = {
            type: "error",
            message: this.$t("authentication.tooManyRequests") as string
          };
          return;
        }

        this.message = {
          type: "error",
          message: this.$t("authentication.signInFailed") as string
        };
      } finally {
        this.loading = false;
      }
    }
  }
});
</script>
