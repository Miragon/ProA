<template>
  <Dialog v-model:open="showDialog">
    <DialogContent
      class="tw:max-h-[90vh] tw:overflow-y-auto"
      :show-close-button="false"
      @escape-key-down="preventEscapeClose"
    >
      <ProfileDialog v-if="selectedDialog === SelectedDialog.PROFILE" />
    </DialogContent>
  </Dialog>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import ProfileDialog from "@/components/Authentication/ProfileDialog.vue";
import { useAppStore } from "@/store/app";
import { SelectedDialog } from "@/store/app";
import { Dialog, DialogContent } from "@/components/ui/dialog";

export default defineComponent({
  name: "AuthenticationDialog",
  components: {
    ProfileDialog,
    Dialog,
    DialogContent
  },

  data() {
    return {
      SelectedDialog: SelectedDialog,
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

  methods: {
    /** The previous Vuetify dialog was `persistent`: ESC did not close it. */
    preventEscapeClose(event: KeyboardEvent) {
      event.preventDefault();
    }
  }
});
</script>
