<template>
  <div class="tw:flex tw:flex-col tw:gap-4">
    <DialogHeader>
      <div class="tw:flex tw:items-center tw:justify-between">
        <DialogTitle>{{ $t("authentication.createAnAccount") }}</DialogTitle>
        <Button variant="ghost" size="icon" type="button" @click="closeDialog">
          <X />
          <span class="tw:sr-only">{{ $t("general.close") }}</span>
        </Button>
      </div>
      <DialogDescription class="tw:sr-only">
        {{ $t("authentication.createAccountDescription") }}
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
        <Label for="create-account-email">
          {{ $t("authentication.email") }}
        </Label>
        <Input
          id="create-account-email"
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
        <Label for="create-account-first-name">
          {{ $t("authentication.firstName") }}
        </Label>
        <Input
          id="create-account-first-name"
          v-model="firstName"
          type="text"
          required
          :aria-invalid="!!errors.firstName || undefined"
        />
        <p v-if="errors.firstName" class="tw:text-destructive tw:text-sm">
          {{ errors.firstName }}
        </p>
      </div>
      <div class="tw:flex tw:flex-col tw:gap-2">
        <Label for="create-account-last-name">
          {{ $t("authentication.lastName") }}
        </Label>
        <Input
          id="create-account-last-name"
          v-model="lastName"
          type="text"
          required
          :aria-invalid="!!errors.lastName || undefined"
        />
        <p v-if="errors.lastName" class="tw:text-destructive tw:text-sm">
          {{ errors.lastName }}
        </p>
      </div>
      <div class="tw:flex tw:flex-col tw:gap-2">
        <Label for="create-account-password">
          {{ $t("authentication.password") }}
        </Label>
        <Input
          id="create-account-password"
          v-model="password"
          type="password"
          autocomplete="new-password"
          required
          :aria-invalid="!!errors.password || undefined"
        />
        <p v-if="errors.password" class="tw:text-destructive tw:text-sm">
          {{ errors.password }}
        </p>
      </div>
      <div class="tw:flex tw:flex-col tw:gap-2">
        <Label for="create-account-role">{{ $t("authentication.role") }}</Label>
        <Select v-model="selectedRole">
          <SelectTrigger id="create-account-role" class="tw:w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem
                v-for="option in localizedRoleOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <Button type="button" size="lg" class="tw:w-full" @click="createAccount">
        {{ $t("general.continue") }}
      </Button>
    </form>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import {
  emailRules,
  firstNameRules,
  firstRuleError,
  lastNameRules,
  newPasswordRules
} from "@/components/Authentication/formValidation";
import { AxiosError } from "axios";
import { SelectedDialog, useAppStore } from "@/store/app";
import { Message } from "@/components/Authentication/AuthenticationDialog.vue";
import { register } from "@/api/auth";
import { Role } from "@/components/ProcessMap/types";
import { CircleAlert, CircleCheck, X } from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

export default defineComponent({
  name: "CreateAccount",

  components: {
    Alert,
    AlertDescription,
    Button,
    CircleAlert,
    CircleCheck,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectTrigger,
    SelectValue,
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
      email: "" as string,
      password: "" as string,
      firstName: "" as string,
      lastName: "" as string,
      errors: { email: "", firstName: "", lastName: "", password: "" },
      SelectedDialog: SelectedDialog,
      store: useAppStore(),
      selectedRole: Role.USER
    };
  },

  computed: {
    localizedRoleOptions() {
      const roles = Object.values(Role);
      return roles.map((role) => ({
        value: role,
        label: this.$t(`authentication.${role.toLowerCase()}`)
      }));
    }
  },

  watch: {
    // "Reward early, punish late": only re-validate a field while typing
    // once an error is already shown, so valid input clears it immediately.
    email(value: string) {
      if (this.errors.email) {
        this.errors.email = firstRuleError(value, emailRules);
      }
    },
    firstName(value: string) {
      if (this.errors.firstName) {
        this.errors.firstName = firstRuleError(value, firstNameRules);
      }
    },
    lastName(value: string) {
      if (this.errors.lastName) {
        this.errors.lastName = firstRuleError(value, lastNameRules);
      }
    },
    password(value: string) {
      if (this.errors.password) {
        this.errors.password = firstRuleError(value, newPasswordRules);
      }
    }
  },

  methods: {
    validate(): boolean {
      this.errors.email = firstRuleError(this.email, emailRules);
      this.errors.firstName = firstRuleError(this.firstName, firstNameRules);
      this.errors.lastName = firstRuleError(this.lastName, lastNameRules);
      this.errors.password = firstRuleError(this.password, newPasswordRules);
      return (
        !this.errors.email &&
        !this.errors.firstName &&
        !this.errors.lastName &&
        !this.errors.password
      );
    },
    async createAccount() {
      this.$emit("showMessage", { message: "", type: "error" } as Message);
      if (!this.validate()) {
        return;
      }

      try {
        await register({
          email: this.email,
          password: this.password,
          firstName: this.firstName,
          lastName: this.lastName,
          role: this.selectedRole
        });

        this.$emit("showMessage", {
          type: "success",
          message: this.$t(
            "authentication.successfullyCreatedAccount"
          ) as string
        });

        if (this.$route.name === "ManageUsers") {
          this.closeDialog();
          window.location.reload();
        }
        this.resetForm();
      } catch (e) {
        if ((e as AxiosError).response?.status === 409) {
          this.$emit("showMessage", {
            type: "error",
            message: this.$t("authentication.emailAlreadyRegistered") as string
          });
          return;
        }

        if ((e as AxiosError).response?.status === 429) {
          this.$emit("showMessage", {
            type: "error",
            message: this.$t("authentication.tooManyRequests") as string
          });
          return;
        }

        this.$emit("showMessage", {
          type: "error",
          message: this.$t("authentication.accountCreationFailed") as string
        });
      }
    },
    closeDialog() {
      this.store.setSelectedDialog(SelectedDialog.NONE);
    },
    removeMessage() {
      this.$emit("removeMessage");
    },
    resetForm() {
      this.email = "";
      this.password = "";
      this.firstName = "";
      this.lastName = "";
      this.selectedRole = Role.USER;
      this.errors = { email: "", firstName: "", lastName: "", password: "" };
    }
  }
});
</script>
