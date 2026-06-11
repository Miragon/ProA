<template>
  <v-container fluid style="margin: auto">
    <v-banner
      v-if="showLoggedInBanner && webVersion && isUserLoggedIn"
      color="success"
      icon="mdi-check"
      lines="one"
      :text="$t('projectOverview.welcomeBack') + user.firstName + '!'"
      :stacked="false"
      sticky
    >
      <template #actions>
        <v-btn icon @click="showLoggedInBanner = false">
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </template>
    </v-banner>

    <v-card
      v-for="(project, index) in projects"
      :key="index"
      width="310px"
      height="265px"
      style="float: left; margin: 16px"
      :class="{
        'active-card': store.getSelectedProjectId() === project.id
      }"
    >
      <div
        class="d-flex flex-row justify-space-between align-center"
        style="width: 100%; overflow: hidden"
      >
        <v-card-title class="text-truncate" style="flex: 1; min-width: 0">
          {{ project.name }}
        </v-card-title>

        <v-btn
          class="ma-1 flex-shrink-0"
          icon="mdi-cog"
          variant="plain"
          size="small"
          @click="editProject(project.id)"
        ></v-btn>
      </div>
      <div class="d-flex flex-row justify-space-between align-center">
        <span
          v-if="project.id === store.getSelectedProjectId()"
          class="mb-3 px-4 active-text"
          >{{ $t("projectOverview.active") }}</span
        >
      </div>
      <v-card-text class="pt-0">
        <v-select
          label="Version"
          :value="getActiveVersionForProject(project.id).name"
          :items="project.versions"
          item-title="name"
          item-value="id"
          hide-details
          @update:model-value="
            setActiveVersionFromSelect(project.id, $event, project.versions)
          "
        ></v-select>
        <v-btn
          class="mt-3"
          append-icon="mdi-plus"
          lines="two"
          :text="$t('projectOverview.addVersion')"
          link
          variant="tonal"
          @click="openNewVersionDialog(project)"
        ></v-btn>
      </v-card-text>
      <v-divider></v-divider>
      <v-list-item
        append-icon="mdi-chevron-right"
        lines="two"
        :subtitle="$t('projectOverview.open')"
        link
        @click="() => openProject(project.id)"
      ></v-list-item>
      <!--      <v-card-actions class="justify-end">
              <v-btn
                icon
                color="grey"
                @click="
                  openDeleteDialog(
                    project,
                    store.getActiveVersionForProject(project.id)
                  )
                "
              >
                <v-icon>mdi-delete</v-icon>
              </v-btn>
            </v-card-actions>-->
    </v-card>

    <v-dialog v-model="confirmDeleteDialog" max-width="400">
      <v-card
        prepend-icon="mdi-delete"
        :title="$t('projectOverview.confirmDeletion')"
      >
        <template #text>
          <i18n-t
            keypath="projectOverview.confirmDeletionText"
            tag="div"
            scope="global"
          >
            <template #version>
              <b>{{ projectVersionToBeDeleted!.name }}</b>
            </template>
            <template #project>
              <b>{{ projectForDeletingVersion!.name }}</b>
            </template>
          </i18n-t>
        </template>
        <template #actions>
          <div class="ms-auto">
            <v-btn
              :text="$t('general.cancel')"
              @click="confirmDeleteDialog = false"
            ></v-btn>
            <v-btn
              :text="$t('projectOverview.confirm')"
              @click="confirmDelete"
            ></v-btn>
          </div>
        </template>
      </v-card>
    </v-dialog>

    <v-card
      width="310px"
      height="265px"
      style="float: left; margin: 16px"
      class="d-flex flex-column"
      @click="handleOpenNewProjectDialog"
    >
      <v-card-title
        class="d-flex flex-column justify-center align-center flex-grow-1"
      >
        <v-icon icon="mdi-plus" size="x-large"></v-icon>
        <div>{{ $t("projectOverview.newProject") }}</div>
      </v-card-title>
    </v-card>
    <v-dialog v-model="projectDialog" persistent width="600">
      <v-card>
        <v-container>
          <v-card-title
            >{{ $t("projectOverview.createProject") }}
          </v-card-title>
          <v-card-text>
            <v-text-field
              ref="newProjectNameInput"
              v-model="newProjectName"
              label="Name"
              :rules="[
                () =>
                  !!newProjectName || $t('projectOverview.projectNameRequired')
              ]"
            ></v-text-field>
            <v-text-field
              ref="newProjectVersionNameInput"
              v-model="newProjectVersionName"
              label="Version"
              placeholder="1.0"
              :rules="newProjectVersionRules"
            ></v-text-field>
          </v-card-text>
          <v-card-actions>
            <v-spacer></v-spacer>
            <v-btn
              color="blue-darken-1"
              variant="text"
              @click="closeNewProjectOrVersionDialog"
            >
              {{ $t("general.cancel") }}
            </v-btn>
            <v-btn
              color="blue-darken-1"
              variant="text"
              @click="createProject()"
            >
              {{ $t("general.save") }}
            </v-btn>
          </v-card-actions>
        </v-container>
      </v-card>
    </v-dialog>
    <v-dialog v-model="showNewVersionDialog" persistent width="600">
      <v-card>
        <v-container>
          <v-card-title>
            {{ $t("projectOverview.newVersionFor") }}
            {{ projectForNewVersion!.name }}
          </v-card-title>
          <v-card-text>
            <v-text-field
              ref="newVersionVersionNameInput"
              v-model="newVersionName"
              :label="$t('projectOverview.newVersion')"
              :rules="newVersionVersionRules"
            ></v-text-field>
          </v-card-text>
          <v-card-actions>
            <v-spacer></v-spacer>
            <v-btn
              color="blue-darken-1"
              variant="text"
              @click="closeNewProjectOrVersionDialog"
            >
              {{ $t("general.cancel") }}
            </v-btn>
            <v-btn
              color="blue-darken-1"
              variant="text"
              @click="createVersion()"
            >
              {{ $t("general.save") }}
            </v-btn>
          </v-card-actions>
        </v-container>
      </v-card>
    </v-dialog>
  </v-container>

  <ProjectDetailDialog
    :show-project-detail-dialog="showProjectDetailDialog"
    :project-detail-id="projectDetailId"
    :project-changed-flag="projectChangedFlag"
    @close="closeProjectDetailDialog"
    @delete-version="openDeleteDialog"
    @reset-project-changed-flag="resetProjectChangedFlag"
  />
</template>
<script lang="ts">
import { defineComponent } from "vue";
import { SnackbarType } from "@/utils/snackbar";
import { useAppStore } from "@/store/app";
import { VTextField } from "vuetify/components";
import * as projectsApi from "@/api/projects";
import { getCurrentUser } from "@/api/users";
import { Project, ProjectVersion } from "@/types/project";
import { UserData } from "@/types/user";
import ProjectDetailDialog from "@/components/Home/ProjectDetailDialog.vue";

export default defineComponent({
  components: { ProjectDetailDialog },
  data: () => {
    const store = useAppStore();
    return {
      store: store,
      projectDetailId: -1 as number,
      projects: [] as Project[],
      projectDialog: false as boolean,
      projectForNewVersion: null as Project | null,
      confirmDeleteDialog: false,
      projectChangedFlag: false as boolean,
      projectForDeletingVersion: null as Project | null,
      projectVersionToBeDeleted: null as ProjectVersion | null,
      showNewVersionDialog: false as boolean,
      showProjectDetailDialog: false as boolean,
      newProjectName: "" as string,
      newProjectVersionName: "" as string,
      newVersionName: "" as string,
      showLoggedInBanner: false as boolean,
      webVersion: (import.meta.env.VITE_APP_MODE === "web") as boolean,
      user: {} as UserData
    };
  },

  computed: {
    isUserLoggedIn() {
      return this.store.getUserToken() != null;
    },
    newProjectVersionRules() {
      return [
        (): boolean | string =>
          !this.newProjectVersionNameExists ||
          this.$t("projectOverview.versionNameExists"),
        (): boolean | string =>
          !!this.newProjectVersionName ||
          this.$t("projectOverview.versionNameRequired")
      ];
    },
    newVersionVersionRules() {
      return [
        (): boolean | string =>
          !this.newVersionVersionNameExists ||
          this.$t("projectOverview.versionNameExists"),
        (): boolean | string =>
          !!this.newVersionName ||
          this.$t("projectOverview.versionNameRequired")
      ];
    },
    newProjectVersionNameExists() {
      return !!this.projects.find(
        (project) =>
          project.versions
            .map((version) => version.name)
            .includes(this.newProjectVersionName) &&
          project.name === this.newProjectName
      );
    },
    newVersionVersionNameExists() {
      return this.projectForNewVersion?.versions
        .map((version) => version.name)
        .includes(this.newVersionName);
    }
  },

  mounted: async function () {
    if (this.store.getUserToken() != null) this.user = await getCurrentUser();

    const currentState = window.history.state || {};

    this.showLoggedInBanner = currentState.showLoggedInBanner;

    const updatedState = { ...currentState, showLoggedInBanner: false };
    window.history.replaceState(updatedState, document.title);

    await this.fetchProjects();
  },
  methods: {
    openNewVersionDialog(project: Project) {
      this.newVersionName = "";
      this.projectForNewVersion = project;
      this.showNewVersionDialog = true;
    },
    handleOpenNewProjectDialog() {
      this.openNewProjectDialog();
    },
    openNewProjectDialog() {
      this.newProjectName = "";
      this.newProjectVersionName = "";
      this.projectDialog = true;
    },
    setActiveVersionFromSelect(
      projectId: number,
      versionId: number,
      versions: ProjectVersion[]
    ) {
      const version = versions.find((version) => version.id === versionId);
      this.store.setActiveVersionForProject(projectId, version!);
    },
    async fetchProjects() {
      if (this.webVersion && !this.isUserLoggedIn) {
        return;
      }

      try {
        const projects = await projectsApi.getProjects();
        const selectedProjectId = this.store.getSelectedProjectId();
        this.projects = projects.sort(
          (project1: Project, project2: Project) => {
            if (project1.id === selectedProjectId) return -1;
            if (project2.id === selectedProjectId) return 1;
            return 0;
          }
        );
        this.syncActiveVersions();
      } catch {
        this.projects = [];
      }
    },
    syncActiveVersions() {
      for (const project of this.projects) {
        const currentActiveVersion = this.store.getActiveVersionForProject(
          project.id
        );
        if (
          !currentActiveVersion ||
          !project.versions
            .map((version) => version.id)
            .includes(currentActiveVersion.id)
        ) {
          this.store.setActiveVersionForProject(
            project.id,
            project.versions[0]
          );
        }
      }
    },
    getActiveVersionForProject(projectId: number): ProjectVersion {
      return this.store.getActiveVersionForProject(projectId);
    },
    async createProject() {
      const newProjectNameInput = this.$refs.newProjectNameInput as VTextField;
      const newProjectVersionNameInput = this.$refs
        .newProjectVersionNameInput as VTextField;

      let errors: string[] = [];
      errors = errors.concat(await newProjectNameInput.validate());
      errors = errors.concat(await newProjectVersionNameInput.validate());
      if (errors.length > 0) {
        return;
      }

      const newProjectName = this.newProjectName;
      const newProjectVersionName = this.newProjectVersionName;

      for (const project of this.projects) {
        if (project.name === newProjectName) {
          this.projectForNewVersion = project;
          this.newVersionName = newProjectVersionName;
          await this.createVersion();
          return;
        }
      }

      try {
        const project = await projectsApi.createProject(
          newProjectName,
          newProjectVersionName
        );

        this.projectDialog = false;
        this.store.setActiveVersionForProject(project.id, project.versions[0]);
        this.projects.push(project);

        await this.store.showSnackbar(
          this.$t("projectOverview.projectSuccessfullyCreated"),
          SnackbarType.SUCCESS
        );
      } catch {
        await this.store.showSnackbar(
          this.$t("projectOverview.errorMessage"),
          SnackbarType.ERROR
        );
      }
    },
    async createVersion() {
      const newVersionVersionNameInput = this.$refs
        .newVersionVersionNameInput as VTextField;

      const errors = newVersionVersionNameInput
        ? await newVersionVersionNameInput.validate()
        : [];
      if (errors.length > 0) {
        return;
      }

      const projectId = this.projectForNewVersion!.id;

      try {
        const version = await projectsApi.createProjectVersion(
          projectId,
          this.newVersionName
        );
        this.store.setActiveVersionForProject(projectId, version);
        for (const project of this.projects) {
          if (project.id === projectId) {
            project.versions.push(version);
          }
        }

        this.showNewVersionDialog = false;
        this.projectDialog = false;

        await this.store.showSnackbar(
          this.$t("projectOverview.versionSuccessfullyCreated"),
          SnackbarType.SUCCESS
        );
      } catch {
        await this.store.showSnackbar(
          this.$t("projectOverview.errorMessage"),
          SnackbarType.ERROR
        );
      }
    },
    openDeleteDialog(project: Project, projectVersion: ProjectVersion) {
      this.projectForDeletingVersion = project;
      this.projectVersionToBeDeleted = projectVersion;
      this.confirmDeleteDialog = true;
    },
    async confirmDelete() {
      try {
        await this.deleteProjectVersion(
          this.projectForDeletingVersion!.id,
          this.projectVersionToBeDeleted!.id
        );
        await this.fetchProjects();
        await this.store.showSnackbar(
          this.$t("projectOverview.projectSuccessfullyDeleted"),
          SnackbarType.SUCCESS
        );
      } catch {
        await this.store.showSnackbar(
          this.$t("projectOverview.errorMessage"),
          SnackbarType.ERROR
        );
      } finally {
        this.confirmDeleteDialog = false;
        if (this.showProjectDetailDialog) {
          if (
            !this.projects
              .map((project) => project.id)
              .includes(this.projectForDeletingVersion!.id)
          ) {
            this.showProjectDetailDialog = false;
          } else {
            this.projectChangedFlag = true;
          }
        }
      }
    },
    async deleteProjectVersion(projectId: number, versionId: number) {
      await projectsApi.deleteProjectVersion(projectId, versionId);
    },
    openProject(id: number) {
      this.store.setSelectedProjectId(id);
      this.$router.push("/ProcessList");
    },
    closeNewProjectOrVersionDialog() {
      this.projectDialog = false;
      this.showNewVersionDialog = false;
    },
    editProject(id: number) {
      this.projectDetailId = id;
      this.showProjectDetailDialog = true;
    },
    closeProjectDetailDialog() {
      this.showProjectDetailDialog = false;
    },
    resetProjectChangedFlag() {
      this.projectChangedFlag = false;
    }
  }
});
</script>
<style scoped>
@import "@/styles/global.css";

.active-card {
  box-shadow: 0 0 10px 3px rgba(24, 103, 192, 0.5);
}

.active-text {
  color: #1867c0;
  font-weight: 500;
  font-size: 0.875rem;
}
</style>
