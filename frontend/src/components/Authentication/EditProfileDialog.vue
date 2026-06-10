<template>
  <div class="flex flex-col gap-4">
    <DialogHeader>
      <div class="flex items-center justify-between gap-2">
        <DialogTitle>{{ $t("authentication.editYourProfile") }}</DialogTitle>
        <div class="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            @click="openDialog(SelectedDialog.PROFILE)"
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
        <p v-if="errors.firstName" class="text-destructive text-sm">
          {{ errors.firstName }}
        </p>
      </div>
      <div class="flex flex-col gap-2">
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
        <p v-if="errors.lastName" class="text-destructive text-sm">
          {{ errors.lastName }}
        </p>
      </div>
      <div class="flex flex-col gap-2">
        <Label for="edit-profile-email">
          {{ $t("authentication.email") }}
        </Label>
        <Input
          id="edit-profile-email"
          v-model="newUserData.email"
          type="email"
          autocomplete="email"
          required
          :aria-invalid="!!errors.email || undefined"
        />
        <p v-if="errors.email" class="text-destructive text-sm">
          {{ errors.email }}
        </p>
      </div>
      <Button type="button" size="lg" class="w-full" @click="updateUser">
        {{ $t("general.save") }}
      </Button>
    </form>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { SelectedDialog, useAppStore } from "@/store/app";
import {
  emailRules,
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
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
      errors: { firstName: "", lastName: "", email: "" },
      SelectedDialog: SelectedDialog
    };
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
      this.errors.email = firstRuleError(this.newUserData.email, emailRules);
      return (
        !this.errors.firstName && !this.errors.lastName && !this.errors.email
      );
    },
    async updateUser() {
      this.$emit("showMessage", { message: "", type: "error" } as Message);
      if (!this.validate()) {
        return;
      }
      const currUserData = await getCurrentUser();
      if (JSON.stringify(this.newUserData) === JSON.stringify(currUserData)) {
        this.openDialog(SelectedDialog.PROFILE);
        return;
      }
      try {
        await updateCurrentUser(this.newUserData);

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
