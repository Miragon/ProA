<template>
  <v-dialog v-model="dialogModel" width="600">
    <v-card>
      <v-container>
        <v-card-title>{{ project.name }}</v-card-title>
        <v-divider />
        <v-card-text>
          <div class="card-section">
            <p class="text-body-1 font-weight-bold">
              {{ $t("projectOverview.contributors") + ": " }}
            </p>
            <p
              v-for="member in project.projectMembers"
              :key="'member-' + member.id"
              class="text-body-1 deletable"
            >
              {{ member.firstName + " " + member.lastName }}
              <span class="font-weight-thin font-italic">{{
                member.role
              }}</span>
            </p>
            <v-text-field
              ref="newMemberEmailInput"
              v-model="newMemberEmail"
              class="mt-2"
              :label="$t('authentication.email')"
              density="compact"
              :rules="emailRules"
              :error-messages="newMemberErrorMsg"
              @input="newMemberErrorMsg = ''"
              @focusout="resetValidation"
            >
              <template #append>
                <v-btn
                  append-icon="mdi-plus"
                  :text="$t('projectOverview.inviteMember')"
                  variant="tonal"
                  @click="inviteMember"
                ></v-btn>
              </template>
            </v-text-field>

            <div
              v-if="invitations.length > 0"
              class="tw:mt-2 tw:flex tw:flex-col tw:gap-2"
            >
              <p class="text-body-1 font-weight-bold">
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

          <div class="card-section">
            <p class="text-body-1 font-weight-bold">
              {{ $t("projectOverview.versions") + ": " }}
            </p>
            <p
              v-for="version in project.versions"
              :key="'version-' + version.id"
              class="text-body-1 deletable"
              @click="deleteVersion(project, version)"
            >
              {{ version.name }}
            </p>
          </div>

          <div class="card-section mb-3">
            <div class="mb-1">
              <span class="text-body-1 font-weight-bold">
                {{ $t("general.createdOn") + ": " }}
              </span>
              <span class="text-body-1">
                {{ formatDate(project.createdAt) }}
              </span>
            </div>
            <div>
              <span class="text-body-1 font-weight-bold">
                {{ $t("general.lastModifiedOn") + ": " }}
              </span>
              <span class="text-body-1">
                {{ formatDate(project.modifiedAt) }}
              </span>
            </div>
          </div>
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn color="blue-darken-1" variant="text" @click="closeDialog">
            {{ $t("general.close") }}
          </v-btn>
        </v-card-actions>
      </v-container>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { PendingInvitation, Project, ProjectVersion } from "@/types/project";
import { AxiosError } from "axios";
import * as projectsApi from "@/api/projects";
import { useAppStore } from "@/store/app";
import { SnackbarType } from "@/utils/snackbar";
import { VTextField } from "vuetify/components";
import { emailRules } from "@/components/Authentication/formValidation";
import { X } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
      const newMemberEmailInput = this.$refs.newMemberEmailInput as VTextField;

      const errors = await newMemberEmailInput.validate();
      if (errors.length > 0) {
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
      const newMemberEmailInput = this.$refs.newMemberEmailInput as VTextField;
      newMemberEmailInput.resetValidation();
    },
    deleteVersion(project: Project, version: ProjectVersion) {
      this.$emit("deleteVersion", project, version);
    }
  }
});
</script>

<style scoped>
.card-section {
  margin: 2rem 0;
}

.deletable:hover {
  cursor: pointer;
  text-decoration: line-through;
}
</style>
