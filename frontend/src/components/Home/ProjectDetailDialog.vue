<template>
  <Dialog v-model:open="dialogModel">
    <DialogContent
      class="tw:max-h-[90vh] tw:overflow-y-auto tw:sm:max-w-[600px]"
    >
      <DialogHeader>
        <DialogTitle>{{ project.name }}</DialogTitle>
      </DialogHeader>

      <Separator />

      <div class="tw:flex tw:flex-col tw:gap-2">
        <p class="tw:font-bold">
          {{ $t("projectOverview.contributors") + ": " }}
        </p>
        <p
          v-for="member in project.projectMembers"
          :key="'member-' + member.id"
        >
          {{ member.firstName + " " + member.lastName }}
          <span class="tw:text-muted-foreground tw:italic">
            {{ member.role }}
          </span>
        </p>

        <div class="tw:mt-2 tw:flex tw:items-start tw:gap-2">
          <div class="tw:flex tw:flex-1 tw:flex-col tw:gap-1.5">
            <Input
              v-model="newMemberEmail"
              :placeholder="$t('authentication.email')"
              :aria-invalid="!!newMemberErrorMsg"
              @input="newMemberErrorMsg = ''"
              @focusout="resetValidation"
            />
            <span
              v-if="newMemberErrorMsg"
              class="tw:text-destructive tw:text-sm"
            >
              {{ newMemberErrorMsg }}
            </span>
          </div>
          <Button variant="secondary" type="button" @click="inviteMember">
            {{ $t("projectOverview.inviteMember") }}
            <Plus />
          </Button>
        </div>

        <div
          v-if="invitations.length > 0"
          class="tw:mt-2 tw:flex tw:flex-col tw:gap-2"
        >
          <p class="tw:font-bold">
            {{ $t("projectOverview.pendingInvitations") + ": " }}
          </p>
          <TooltipProvider>
            <ul class="tw:flex tw:flex-col tw:gap-1">
              <li
                v-for="invitation in invitations"
                :key="'invitation-' + invitation.id"
                class="tw:flex tw:items-center tw:justify-between tw:gap-2"
              >
                <div class="tw:flex tw:min-w-0 tw:items-center tw:gap-2">
                  <span class="tw:truncate">{{ invitation.email }}</span>
                  <Badge variant="secondary">
                    {{ $t("projectOverview.invited") }}
                  </Badge>
                </div>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      @click="revokeInvitation(invitation)"
                    >
                      <X />
                      <span class="tw:sr-only">
                        {{ $t("projectOverview.revokeInvitation") }}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {{ $t("projectOverview.revokeInvitation") }}
                  </TooltipContent>
                </Tooltip>
              </li>
            </ul>
          </TooltipProvider>
        </div>
      </div>

      <div class="tw:flex tw:flex-col tw:gap-2">
        <p class="tw:font-bold">{{ $t("projectOverview.versions") + ": " }}</p>
        <p
          v-for="version in project.versions"
          :key="'version-' + version.id"
          class="tw:w-fit tw:cursor-pointer tw:hover:line-through"
          @click="deleteVersion(project, version)"
        >
          {{ version.name }}
        </p>
      </div>

      <div class="tw:flex tw:flex-col tw:gap-1">
        <div>
          <span class="tw:font-bold">
            {{ $t("general.createdOn") + ": " }}
          </span>
          <span>{{ formatDate(project.createdAt) }}</span>
        </div>
        <div>
          <span class="tw:font-bold">
            {{ $t("general.lastModifiedOn") + ": " }}
          </span>
          <span>{{ formatDate(project.modifiedAt) }}</span>
        </div>
      </div>

      <Separator />

      <DialogFooter>
        <Button variant="ghost" type="button" @click="closeDialog">
          {{ $t("general.close") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { PendingInvitation, Project, ProjectVersion } from "@/types/project";
import { AxiosError } from "axios";
import * as projectsApi from "@/api/projects";
import { useAppStore } from "@/store/app";
import { SnackbarType } from "@/utils/snackbar";
import { emailRules } from "@/components/Authentication/formValidation";
import { Plus, X } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";

export default defineComponent({
  name: "ProjectDetailDialog",

  components: {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Plus,
    Separator,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    X
  },

  props: {
    showProjectDetailDialog: {
      type: Boolean,
      required: true
    },
    projectDetailId: {
      type: Number,
      required: true
    },
    projectChangedFlag: {
      type: Boolean,
      required: true
    }
  },

  emits: ["resetProjectChangedFlag", "close", "deleteVersion"],

  data: () => ({
    store: useAppStore(),
    emailRules: emailRules,
    newMemberEmail: "" as string,
    newMemberErrorMsg: "" as string,
    project: {} as Project,
    invitations: [] as PendingInvitation[]
  }),

  computed: {
    dialogModel: {
      get(): boolean {
        return this.showProjectDetailDialog;
      },
      set(value: boolean) {
        if (!value) {
          this.$emit("close");
        }
      }
    }
  },

  watch: {
    showProjectDetailDialog(newVal) {
      if (newVal) {
        this.fetchProject();
        this.fetchInvitations();
      }
    },
    projectChangedFlag(newVal) {
      if (newVal) {
        this.fetchProject();
        this.$emit("resetProjectChangedFlag");
      }
    }
  },

  methods: {
    closeDialog() {
      this.$emit("close");
    },
    validateNewMemberEmail(): boolean {
      for (const rule of this.emailRules) {
        const result = rule(this.newMemberEmail);
        if (typeof result === "string") {
          this.newMemberErrorMsg = result;
          return false;
        }
      }
      this.newMemberErrorMsg = "";
      return true;
    },
    async fetchProject() {
      try {
        this.project = await projectsApi.getProject(this.projectDetailId);
      } catch (error) {
        console.error(error);
      }
    },
    async fetchInvitations() {
      try {
        this.invitations = await projectsApi.getInvitations(
          this.projectDetailId
        );
      } catch (error) {
        this.invitations = [];
        // Only owners may list invitations: surface the 403 instead of
        // silently showing nothing.
        if ((error as AxiosError).response?.status === 403) {
          await this.store.showSnackbar(
            this.$t("projectOverview.errorMessage"),
            SnackbarType.ERROR
          );
        } else {
          console.error(error);
        }
      }
    },
    formatDate(dateString: string) {
      const locales =
        this.store.getSelectedLanguage() === "de" ? "de-DE" : "en-US";
      return new Date(dateString).toLocaleString(locales);
    },
    async inviteMember() {
      if (!this.validateNewMemberEmail()) {
        return;
      }

      try {
        const { status } = await projectsApi.inviteMember(
          this.projectDetailId,
          this.newMemberEmail
        );
        this.newMemberEmail = "";
        this.resetValidation();

        if (status === "INVITATION_PENDING") {
          // The invitee has no account yet: the invitation is resolved
          // into a membership on their first sign-in (ADR-0003).
          await this.store.showSnackbar(
            this.$t("projectOverview.invitationSent"),
            SnackbarType.SUCCESS
          );
          await this.fetchInvitations();
        } else {
          await this.store.showSnackbar(
            this.$t("projectOverview.memberAdded"),
            SnackbarType.SUCCESS
          );
          await this.fetchProject();
        }
      } catch {
        this.newMemberErrorMsg = this.$t("projectOverview.errorMessage");
      }
    },
    async revokeInvitation(invitation: PendingInvitation) {
      try {
        await projectsApi.revokeInvitation(this.projectDetailId, invitation.id);
        await this.store.showSnackbar(
          this.$t("projectOverview.invitationRevoked"),
          SnackbarType.SUCCESS
        );
        await this.fetchInvitations();
      } catch {
        await this.store.showSnackbar(
          this.$t("projectOverview.invitationRevokeFailed"),
          SnackbarType.ERROR
        );
      }
    },
    resetValidation() {
      this.newMemberErrorMsg = "";
    },
    deleteVersion(project: Project, version: ProjectVersion) {
      this.$emit("deleteVersion", project, version);
    }
  }
});
</script>
