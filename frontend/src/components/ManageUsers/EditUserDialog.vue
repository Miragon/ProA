<template>
  <Dialog v-model:open="dialogModel">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ $t("manageUsers.editProfile") }}</DialogTitle>
        <DialogDescription class="tw:sr-only">
          {{ $t("manageUsers.editProfileDescription") }}
        </DialogDescription>
      </DialogHeader>

      <Separator />

      <form class="tw:flex tw:flex-col tw:gap-4" novalidate @submit.prevent>
        <div class="tw:flex tw:flex-col tw:gap-2">
          <Label for="edit-user-email">{{ $t("authentication.email") }}</Label>
          <Input
            id="edit-user-email"
            :model-value="userEmail"
            type="email"
            readonly
            disabled
          />
          <p class="tw:text-muted-foreground tw:text-sm">
            {{ $t("authentication.emailManagedBySso") }}
          </p>
        </div>
        <div class="tw:flex tw:flex-col tw:gap-2">
          <Label for="edit-user-first-name">
            {{ $t("authentication.firstName") }}
          </Label>
          <Input
            id="edit-user-first-name"
            v-model="localUserFirstName"
            type="text"
            :aria-invalid="!!errors.firstName || undefined"
          />
          <p v-if="errors.firstName" class="tw:text-destructive tw:text-sm">
            {{ errors.firstName }}
          </p>
        </div>
        <div class="tw:flex tw:flex-col tw:gap-2">
          <Label for="edit-user-last-name">
            {{ $t("authentication.lastName") }}
          </Label>
          <Input
            id="edit-user-last-name"
            v-model="localUserLastName"
            type="text"
            :aria-invalid="!!errors.lastName || undefined"
          />
          <p v-if="errors.lastName" class="tw:text-destructive tw:text-sm">
            {{ errors.lastName }}
          </p>
        </div>
      </form>

      <DialogFooter class="tw:sm:justify-between">
        <Button type="button" @click="patchUser(userId)">
          {{ $t("manageUsers.saveChanges") }}
        </Button>
        <Button
          v-if="ownUserId !== userId"
          type="button"
          variant="destructive"
          @click="deleteUser(userId)"
        >
          {{ $t("manageUsers.deleteUser") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import * as usersApi from "@/api/users";
import {
  firstNameRules,
  firstRuleError,
  lastNameRules
} from "@/components/Authentication/formValidation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default defineComponent({
  name: "EditUserDialog",
  components: {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Separator
  },
  props: {
    showDialog: {
      type: Boolean,
      default: false
    },
    userId: {
      type: Number,
      required: true
    },
    userEmail: {
      type: String,
      required: true
    },
    userFirstName: {
      type: String,
      required: true
    },
    userLastName: {
      type: String,
      required: true
    },
    userCreatedAt: {
      type: String,
      required: true
    },
    userModifiedAt: {
      type: String,
      required: true
    },
    ownUserId: {
      type: Number,
      required: true
    }
  },

  emits: ["close", "deleteUser", "fetchUsers"],

  data() {
    return {
      localUserFirstName: "" as string,
      localUserLastName: "" as string,
      errors: { firstName: "", lastName: "" }
    };
  },

  computed: {
    dialogModel: {
      get(): boolean {
        return this.showDialog;
      },
      set(value: boolean) {
        if (!value) {
          this.$emit("close");
        }
      }
    }
  },

  watch: {
    showDialog(newValue: boolean) {
      if (newValue) {
        this.localUserFirstName = this.userFirstName;
        this.localUserLastName = this.userLastName;
        this.errors = {
          firstName: "",
          lastName: ""
        };
      }
    },
    // "Reward early, punish late": only re-validate a field while typing
    // once an error is already shown, so valid input clears it immediately.
    localUserFirstName(value: string) {
      if (this.errors.firstName) {
        this.errors.firstName = firstRuleError(value, firstNameRules);
      }
    },
    localUserLastName(value: string) {
      if (this.errors.lastName) {
        this.errors.lastName = firstRuleError(value, lastNameRules);
      }
    }
  },

  methods: {
    closeDialog() {
      this.$emit("close");
    },
    validate(): boolean {
      this.errors.firstName = firstRuleError(
        this.localUserFirstName,
        firstNameRules
      );
      this.errors.lastName = firstRuleError(
        this.localUserLastName,
        lastNameRules
      );
      return !this.errors.firstName && !this.errors.lastName;
    },
    async deleteUser(id: number) {
      await usersApi.deleteUser(id);
      this.$emit("deleteUser", id);
      this.closeDialog();
    },
    async patchUser(id: number) {
      if (!this.validate()) {
        return;
      }

      // Email and credentials are owned by Keycloak; only the local
      // profile names can be edited here.
      await usersApi.updateUser(id, {
        firstName:
          this.localUserFirstName != this.userFirstName
            ? this.localUserFirstName
            : null,
        lastName:
          this.localUserLastName != this.userLastName
            ? this.localUserLastName
            : null
      });
      this.$emit("fetchUsers");
      this.closeDialog();
    }
  }
});
</script>
