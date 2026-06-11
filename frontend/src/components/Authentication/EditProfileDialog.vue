<template>
  <div class="tw:flex tw:flex-col tw:gap-4">
    <DialogHeader>
      <div class="tw:flex tw:items-center tw:justify-between tw:gap-2">
        <DialogTitle>{{ $t("authentication.editYourProfile") }}</DialogTitle>
        <div class="tw:flex tw:items-center tw:gap-2">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            @click="openDialog(SelectedDialog.PROFILE)"
          >
            <ArrowLeft />
            <span class="tw:sr-only">{{ $t("general.back") }}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            @click="closeDialog"
          >
            <X />
            <span class="tw:sr-only">{{ $t("general.close") }}</span>
          </Button>
        </div>
      </div>
      <DialogDescription class="tw:sr-only">
        {{ $t("authentication.editProfileDescription") }}
      </DialogDescription>
    </DialogHeader>

    <Separator />

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
          @click="removeMessage"
        >
          <X />
          <span class="tw:sr-only">{{ $t("general.close") }}</span>
        </Button>
      </Alert>
      <div class="tw:flex tw:flex-col tw:gap-2">
        <Label for="edit-profile-first-name">
          {{ $t("authentication.firstName") }}
        </Label>
        <Input
          id="edit-profile-first-name"
          v-model="newUserData.firstName"
          type="text"
          required
          :aria-invalid="!!errors.firstName || undefined"
        />
        <p v-if="errors.firstName" class="tw:text-destructive tw:text-sm">
          {{ errors.firstName }}
        </p>
      </div>
      <div class="tw:flex tw:flex-col tw:gap-2">
        <Label for="edit-profile-last-name">
          {{ $t("authentication.lastName") }}
        </Label>
        <Input
          id="edit-profile-last-name"
          v-model="newUserData.lastName"
          type="text"
          required
          :aria-invalid="!!errors.lastName || undefined"
        />
        <p v-if="errors.lastName" class="tw:text-destructive tw:text-sm">
          {{ errors.lastName }}
        </p>
      </div>
      <div class="tw:flex tw:flex-col tw:gap-2">
        <Label for="edit-profile-email">
          {{ $t("authentication.email") }}
        </Label>
        <Input
          id="edit-profile-email"
          :model-value="newUserData.email"
          type="email"
          readonly
          disabled
        />
        <p class="tw:text-muted-foreground tw:text-sm">
          {{ $t("authentication.emailManagedBySso") }}
        </p>
      </div>
      <Button type="button" size="lg" class="tw:w-full" @click="updateUser">
        {{ $t("general.save") }}
      </Button>
    </form>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { SelectedDialog, useAppStore } from "@/store/app";
import {
  firstNameRules,
  firstRuleError,
  lastNameRules
} from "@/components/Authentication/formValidation";
import { AxiosError } from "axios";
import { Message } from "@/components/Authentication/AuthenticationDialog.vue";
import { getCurrentUser, updateCurrentUser } from "@/api/users";
import { UserData } from "@/types/user";
import { ArrowLeft, CircleAlert, CircleCheck, X } from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default defineComponent({
  name: "EditProfileDialog",

  components: {
    Alert,
    AlertDescription,
    ArrowLeft,
    Button,
    CircleAlert,
    CircleCheck,
    DialogDescription,
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
    const store = useAppStore();
    const newUserData = {} as UserData;
    return {
      store,
      newUserData,
      errors: { firstName: "", lastName: "" },
      SelectedDialog: SelectedDialog
    };
  },

  watch: {
    // "Reward early, punish late": only re-validate a field while typing
    // once an error is already shown, so valid input clears it immediately.
    "newUserData.firstName"(value: string) {
      if (this.errors.firstName) {
        this.errors.firstName = firstRuleError(value, firstNameRules);
      }
    },
    "newUserData.lastName"(value: string) {
      if (this.errors.lastName) {
        this.errors.lastName = firstRuleError(value, lastNameRules);
      }
    }
  },

  async mounted() {
    this.newUserData = await getCurrentUser();
  },

  methods: {
    closeDialog() {
      this.store.setSelectedDialog(SelectedDialog.NONE);
    },
    openDialog(dialog: SelectedDialog) {
      this.store.setSelectedDialog(dialog);
    },
    validate(): boolean {
      this.errors.firstName = firstRuleError(
        this.newUserData.firstName,
        firstNameRules
      );
      this.errors.lastName = firstRuleError(
        this.newUserData.lastName,
        lastNameRules
      );
      return !this.errors.firstName && !this.errors.lastName;
    },
    async updateUser() {
      this.$emit("showMessage", { message: "", type: "error" } as Message);
      if (!this.validate()) {
        return;
      }
      const currUserData = await getCurrentUser();
      if (
        this.newUserData.firstName === currUserData.firstName &&
        this.newUserData.lastName === currUserData.lastName
      ) {
        this.openDialog(SelectedDialog.PROFILE);
        return;
      }
      try {
        // The email is owned by Keycloak and deliberately not sent.
        await updateCurrentUser({
          firstName: this.newUserData.firstName,
          lastName: this.newUserData.lastName
        });

        const message: Message = {
          type: "success",
          message: this.$t("authentication.profileSuccessfullyEdited") as string
        };
        if (this.$route.name === "ManageUsers") {
          window.location.reload();
          this.closeDialog();
          return;
        }
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
          message: this.$t("authentication.profileEditFailed") as string
        };
        this.$emit("showMessage", message);
      }
    },
    removeMessage() {
      this.$emit("removeMessage");
    }
  }
});
</script>
