<template>
  <div class="tw:p-4">
    <div
      v-if="showLoggedInBanner && webVersion && isUserLoggedIn"
      class="tw:bg-card tw:text-card-foreground tw:mb-4 tw:flex tw:items-center tw:justify-between tw:rounded-lg tw:border tw:px-4 tw:py-3"
    >
      <div class="tw:flex tw:items-center tw:gap-2">
        <Check class="tw:size-4 tw:shrink-0" />
        <span class="tw:font-medium">
          {{ $t("projectOverview.welcomeBack") + user.firstName + "!" }}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        type="button"
        @click="showLoggedInBanner = false"
      >
        <X />
        <span class="tw:sr-only">{{ $t("general.close") }}</span>
      </Button>
    </div>

    <div class="tw:flex tw:flex-wrap tw:gap-4">
      <Card
        v-for="(project, index) in projects"
        :key="index"
        :class="
          cn(
            'tw:flex tw:w-[310px] tw:flex-col tw:gap-3 tw:py-3',
            store.getSelectedProjectId() === project.id &&
              'tw:ring-2 tw:ring-primary'
          )
        "
      >
        <CardHeader class="tw:flex tw:flex-row tw:items-center tw:gap-2">
          <CardTitle class="tw:min-w-0 tw:flex-1 tw:truncate">
            {{ project.name }}
          </CardTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            @click="editProject(project.id)"
          >
            <Settings />
            <span class="tw:sr-only">{{ $t("general.settings") }}</span>
          </Button>
        </CardHeader>

        <CardContent class="tw:flex tw:flex-col tw:gap-3">
          <span
            v-if="project.id === store.getSelectedProjectId()"
            class="tw:text-primary tw:text-sm tw:font-medium"
          >
            {{ $t("projectOverview.active") }}
          </span>

          <Select
            :model-value="String(getActiveVersionForProject(project.id).id)"
            @update:model-value="
              (value) =>
                setActiveVersionFromSelect(
                  project.id,
                  Number(value),
                  project.versions
                )
            "
          >
            <SelectTrigger class="tw:w-full">
              <SelectValue
                :placeholder="getActiveVersionForProject(project.id).name"
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="version in project.versions"
                :key="'version-' + version.id"
                :value="String(version.id)"
              >
                {{ version.name }}
              </SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant="secondary"
            type="button"
            @click="openNewVersionDialog(project)"
          >
            {{ $t("projectOverview.addVersion") }}
            <Plus />
          </Button>
        </CardContent>

        <Separator />

        <Button
          variant="ghost"
          type="button"
          class="tw:justify-between tw:rounded-none"
          @click="openProject(project.id)"
        >
          {{ $t("projectOverview.open") }}
          <ChevronRight />
        </Button>
      </Card>

      <Card
        class="tw:flex tw:h-[265px] tw:w-[310px] tw:cursor-pointer tw:flex-col tw:items-center tw:justify-center tw:gap-2 tw:hover:bg-accent"
        @click="handleOpenNewProjectDialog"
      >
        <Plus class="tw:size-8" />
        <span class="tw:font-semibold">
          {{ $t("projectOverview.newProject") }}
        </span>
      </Card>
    </div>
  </div>

  <Dialog v-model:open="confirmDeleteDialog">
    <DialogContent class="tw:sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle class="tw:flex tw:items-center tw:gap-2">
          <Trash2 class="tw:size-5" />
          {{ $t("projectOverview.confirmDeletion") }}
        </DialogTitle>
        <DialogDescription>
          <i18n-t
            keypath="projectOverview.confirmDeletionText"
            tag="span"
            scope="global"
          >
            <template #version>
              <b>{{ projectVersionToBeDeleted!.name }}</b>
            </template>
            <template #project>
              <b>{{ projectForDeletingVersion!.name }}</b>
            </template>
          </i18n-t>
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          variant="outline"
          type="button"
          @click="confirmDeleteDialog = false"
        >
          {{ $t("general.cancel") }}
        </Button>
        <Button variant="destructive" type="button" @click="confirmDelete">
          {{ $t("projectOverview.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="projectDialog">
    <DialogContent
      class="tw:sm:max-w-[600px]"
      @escape-key-down="preventDialogClose"
      @pointer-down-outside="preventDialogClose"
      @interact-outside="preventDialogClose"
    >
      <DialogHeader>
        <DialogTitle>{{ $t("projectOverview.createProject") }}</DialogTitle>
      </DialogHeader>
      <div class="tw:flex tw:flex-col tw:gap-4">
        <div class="tw:flex tw:flex-col tw:gap-1.5">
          <Label for="new-project-name">Name</Label>
          <Input
            id="new-project-name"
            v-model="newProjectName"
            :aria-invalid="!!newProjectNameError"
          />
          <span
            v-if="newProjectNameError"
            class="tw:text-destructive tw:text-sm"
          >
            {{ newProjectNameError }}
          </span>
        </div>
        <div class="tw:flex tw:flex-col tw:gap-1.5">
          <Label for="new-project-version">Version</Label>
          <Input
            id="new-project-version"
            v-model="newProjectVersionName"
            placeholder="1.0"
            :aria-invalid="!!newProjectVersionError"
          />
          <span
            v-if="newProjectVersionError"
            class="tw:text-destructive tw:text-sm"
          >
            {{ newProjectVersionError }}
          </span>
        </div>
      </div>
      <DialogFooter>
        <Button
          variant="ghost"
          type="button"
          @click="closeNewProjectOrVersionDialog"
        >
          {{ $t("general.cancel") }}
        </Button>
        <Button type="button" @click="createProject()">
          {{ $t("general.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showNewVersionDialog">
    <DialogContent
      class="tw:sm:max-w-[600px]"
      @escape-key-down="preventDialogClose"
      @pointer-down-outside="preventDialogClose"
      @interact-outside="preventDialogClose"
    >
      <DialogHeader>
        <DialogTitle>
          {{ $t("projectOverview.newVersionFor") }}
          {{ projectForNewVersion!.name }}
        </DialogTitle>
      </DialogHeader>
      <div class="tw:flex tw:flex-col tw:gap-1.5">
        <Label for="new-version-name">
          {{ $t("projectOverview.newVersion") }}
        </Label>
        <Input
          id="new-version-name"
          v-model="newVersionName"
          :aria-invalid="!!newVersionError"
        />
        <span v-if="newVersionError" class="tw:text-destructive tw:text-sm">
          {{ newVersionError }}
        </span>
      </div>
      <DialogFooter>
        <Button
          variant="ghost"
          type="button"
          @click="closeNewProjectOrVersionDialog"
        >
          {{ $t("general.cancel") }}
        </Button>
        <Button type="button" @click="createVersion()">
          {{ $t("general.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

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
import * as projectsApi from "@/api/projects";
import { getCurrentUser } from "@/api/users";
import { Project, ProjectVersion } from "@/types/project";
import { UserData } from "@/types/user";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, Plus, Settings, Trash2, X } from "@lucide/vue";
import ProjectDetailDialog from "@/components/Home/ProjectDetailDialog.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

export default defineComponent({
  components: {
    ProjectDetailDialog,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Check,
    ChevronRight,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Plus,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Separator,
    Settings,
    Trash2,
    X
  },
  data: () => {
    const store = useAppStore();
    return {
      store: store,
      cn,
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
      newProjectNameError: "" as string,
      newProjectVersionError: "" as string,
      newVersionError: "" as string,
      showLoggedInBanner: false as boolean,
      webVersion: (import.meta.env.VITE_APP_MODE === "web") as boolean,
      user: {} as UserData
    };
  },

  computed: {
    isUserLoggedIn() {
      return this.store.getUserToken() != null;
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
    /** The original dialog was `persistent`: it ignored ESC and
     * outside clicks. */
    preventDialogClose(event: Event) {
      event.preventDefault();
    },
    validateNewProjectName(): boolean {
      if (!this.newProjectName) {
        this.newProjectNameError = this.$t(
          "projectOverview.projectNameRequired"
        );
        return false;
      }
      this.newProjectNameError = "";
      return true;
    },
    validateNewProjectVersion(): boolean {
      if (this.newProjectVersionNameExists) {
        this.newProjectVersionError = this.$t(
          "projectOverview.versionNameExists"
        );
        return false;
      }
      if (!this.newProjectVersionName) {
        this.newProjectVersionError = this.$t(
          "projectOverview.versionNameRequired"
        );
        return false;
      }
      this.newProjectVersionError = "";
      return true;
    },
    validateNewVersion(): boolean {
      if (this.newVersionVersionNameExists) {
        this.newVersionError = this.$t("projectOverview.versionNameExists");
        return false;
      }
      if (!this.newVersionName) {
        this.newVersionError = this.$t("projectOverview.versionNameRequired");
        return false;
      }
      this.newVersionError = "";
      return true;
    },
    openNewVersionDialog(project: Project) {
      this.newVersionName = "";
      this.newVersionError = "";
      this.projectForNewVersion = project;
      this.showNewVersionDialog = true;
    },
    handleOpenNewProjectDialog() {
      this.openNewProjectDialog();
    },
    openNewProjectDialog() {
      this.newProjectName = "";
      this.newProjectVersionName = "";
      this.newProjectNameError = "";
      this.newProjectVersionError = "";
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
      const nameValid = this.validateNewProjectName();
      const versionValid = this.validateNewProjectVersion();
      if (!nameValid || !versionValid) {
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
      if (this.showNewVersionDialog && !this.validateNewVersion()) {
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
