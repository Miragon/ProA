<template>
  <div class="flex flex-col gap-4">
    <DialogHeader>
      <div class="flex items-center justify-between gap-2">
        <DialogTitle>{{ $t("authentication.changePassword") }}</DialogTitle>
        <div class="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            @click="resetMessageAndOpenDialog(SelectedDialog.PROFILE)"
          >
            <ArrowLeft />
            <span class="sr-only">{{ $t("general.back") }}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            @click="closeDialog"
          >
            <X />
            <span class="sr-only">{{ $t("general.close") }}</span>
          </Button>
        </div>
      </div>
    </DialogHeader>

    <Separator />

    <form class="flex flex-col gap-4" novalidate @submit.prevent>
      <Alert
        v-if="message.message !== ''"
        :variant="message.type === 'error' ? 'destructive' : 'default'"
        class="pr-10"
      >
        <CircleAlert v-if="message.type === 'error'" />
        <CircleCheck v-else />
        <AlertDescription>{{ message.message }}</AlertDescription>
        <Button
          variant="ghost"
          size="icon-sm"
          class="absolute top-1.5 right-1.5"
          type="button"
          @click="removeMessage"
        >
          <X />
          <span class="sr-only">{{ $t("general.close") }}</span>
        </Button>
      </Alert>
      <div class="flex flex-col gap-2">
        <Label for="change-pw-current">
          {{ $t("authentication.currentPassword") }}
        </Label>
        <Input
          id="change-pw-current"
          v-model="currentPassword"
          type="password"
          autocomplete="current-password"
          required
          :aria-invalid="!!errors.currentPassword || undefined"
        />
        <p v-if="errors.currentPassword" class="text-destructive text-sm">
          {{ errors.currentPassword }}
        </p>
      </div>
      <div class="flex flex-col gap-2">
        <Label for="change-pw-new">
          {{ $t("authentication.newPassword") }}
        </Label>
        <Input
          id="change-pw-new"
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          required
          :aria-invalid="!!errors.newPassword || undefined"
        />
        <p v-if="errors.newPassword" class="text-destructive text-sm">
          {{ errors.newPassword }}
        </p>
      </div>
      <Button type="button" size="lg" class="w-full" @click="changePassword">
        {{ $t("authentication.changePassword") }}
      </Button>
    </form>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";

import {
  currentPasswordRules,
  firstRuleError,
  newPasswordRules
} from "@/components/Authentication/formValidation";
import { Message } from "@/components/Authentication/AuthenticationDialog.vue";
import { SelectedDialog, useAppStore } from "@/store/app";
import { AxiosError } from "axios";
import { login } from "@/api/auth";
import { getCurrentUser, updateCurrentUser } from "@/api/users";
import { UserData } from "@/types/user";
import { ArrowLeft, CircleAlert, CircleCheck, X } from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default defineComponent({
  name: "ChangePassword",

  components: {
    Alert,
    AlertDescription,
    ArrowLeft,
    Button,
    CircleAlert,
    CircleCheck,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Separator,
    X
  },

  props: {
    message: {
      type: Object,
      required: true
    }
  },

  emits: ["showMessage", "removeMessage"],

  data() {
    return {
      currentPassword: "" as string,
      newPassword: "" as string,
      errors: { currentPassword: "", newPassword: "" },
      SelectedDialog: SelectedDialog,
      user: {} as UserData,
      store: useAppStore()
    };
  },

  async mounted() {
    if (this.store.getUserToken() != null) this.user = await getCurrentUser();
  },

  methods: {
    resetMessageAndOpenDialog(selected: SelectedDialog) {
      this.$emit("showMessage", { message: "", type: "error" } as Message);
      this.openDialog(selected);
    },
    closeDialog() {
      this.store.setSelectedDialog(SelectedDialog.NONE);
    },
    openDialog(dialog: SelectedDialog) {
      this.store.setSelectedDialog(dialog);
    },
    validate(): boolean {
      this.errors.currentPassword = firstRuleError(
        this.currentPassword,
        currentPasswordRules
      );
      this.errors.newPassword = firstRuleError(
        this.newPassword,
        newPasswordRules
      );
      return !this.errors.currentPassword && !this.errors.newPassword;
    },
    async changePassword() {
      this.$emit("showMessage", { message: "", type: "error" } as Message);

      if (!this.validate()) {
        return;
      }

      const currPassword = this.currentPassword;
      const { email } = this.user;

      const isPasswordValid = await this.testSignIn(email, currPassword);
      if (!isPasswordValid) {
        const message = {
          message: this.$t("authentication.currentPwWrongError"),
          type: "error"
        };
        this.$emit("showMessage", message);
        return;
      }

      if (currPassword === this.newPassword) {
        const message = {
          message: this.$t("authentication.samePasswordError"),
          type: "error"
        };
        this.$emit("showMessage", message);
        return;
      }

      try {
        await updateCurrentUser({ password: this.newPassword });

        const message: Message = {
          type: "success",
          message: this.$t(
            "authentication.passwordSuccessfullyChanged"
          ) as string
        };
        this.$emit("showMessage", message);
        this.openDialog(SelectedDialog.PROFILE);
      } catch (e) {
        if ((e as AxiosError).response?.status === 429) {
          const message: Message = {
            type: "error",
            message: this.$t("authentication.tooManyRequests") as string
          };
          this.$emit("showMessage", message);
          return;
        }

        const message: Message = {
          type: "error",
          message: this.$t("authentication.passwordChangeErrorMsg") as string
        };
        this.$emit("showMessage", message);
      }
    },
    async testSignIn(email: string, currPassword: string): Promise<boolean> {
      try {
        await login(email, currPassword);
        return true;
      } catch {
        return false;
      }
    },
    removeMessage() {
      this.$emit("removeMessage");
    }
  }
});
</script>
