<template>
  <Dialog v-model:open="showDialog">
    <DialogContent
      class="tw:max-h-[90vh] tw:overflow-y-auto"
      :show-close-button="false"
      @escape-key-down="preventEscapeClose"
    >
      <ProfileDialog
        v-if="selectedDialog === SelectedDialog.PROFILE"
        :message="message"
        @show-message="showMessage"
        @remove-message="removeMessage"
      />
      <EditProfileDialog
        v-if="selectedDialog === SelectedDialog.EDIT_PROFILE"
        :message="message"
        @show-message="showMessage"
        @remove-message="removeMessage"
      />
      <CreateAccount
        v-if="selectedDialog === SelectedDialog.CREATE_ACCOUNT"
        :message="message"
        @show-message="showMessage"
        @remove-message="removeMessage"
      />
      <ChangePassword
        v-if="selectedDialog === SelectedDialog.CHANGE_PW"
        :message="message"
        @show-message="showMessage"
        @remove-message="removeMessage"
      />
    </DialogContent>
  </Dialog>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import EditProfileDialog from "@/components/Authentication/EditProfileDialog.vue";
import ProfileDialog from "@/components/Authentication/ProfileDialog.vue";
import CreateAccount from "@/components/Authentication/CreateAccount.vue";
import ChangePassword from "@/components/Authentication/ChangePassword.vue";
import { useAppStore } from "@/store/app";
import { SelectedDialog } from "@/store/app";
import { Dialog, DialogContent } from "@/components/ui/dialog";

export interface Message {
  message: string;
  type: "error" | "success";
}

export default defineComponent({
  name: "AuthenticationDialog",
  components: {
    ChangePassword,
    CreateAccount,
    ProfileDialog,
    EditProfileDialog,
    Dialog,
    DialogContent
  },

  data() {
    return {
      SelectedDialog: SelectedDialog,
      message: { message: "", type: "error" } as Message,
      store: useAppStore()
    };
  },

  computed: {
    showDialog: {
      get(): boolean {
        return this.store.getSelectedDialog() != SelectedDialog.NONE;
      },
      set(value: boolean) {
        if (!value) {
          this.store.setSelectedDialog(SelectedDialog.NONE);
        }
      }
    },
    selectedDialog(): SelectedDialog {
      return this.store.getSelectedDialog();
    }
  },

  watch: {
    showDialog() {
      if (!this.showDialog) {
        this.resetMessage();
      }
    }
  },

  methods: {
    showMessage(message: Message) {
      this.message = message;
    },
    removeMessage() {
      this.message.message = "";
    },
    resetMessage() {
      this.message = { message: "", type: "error" };
    },
    closeDialog() {
      this.store.setSelectedDialog(SelectedDialog.NONE);
    },
    /** The previous Vuetify dialog was `persistent`: ESC did not close it. */
    preventEscapeClose(event: KeyboardEvent) {
      event.preventDefault();
    }
  }
});
</script>
