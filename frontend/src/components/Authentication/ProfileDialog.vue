<template>
  <div class="tw:flex tw:flex-col tw:gap-4">
    <DialogHeader>
      <div class="tw:flex tw:items-center tw:justify-between">
        <DialogTitle>{{ $t("general.myProfile") }}</DialogTitle>
        <Button variant="ghost" size="icon" type="button" @click="closeDialog">
          <X />
          <span class="tw:sr-only">{{ $t("general.close") }}</span>
        </Button>
      </div>
      <DialogDescription class="tw:sr-only">
        {{ $t("authentication.profileDescription") }}
      </DialogDescription>
    </DialogHeader>

    <Separator />

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

    <div class="tw:flex tw:items-center tw:justify-between">
      <span class="tw:font-semibold">
        {{ user.firstName }} {{ user.lastName }}
      </span>
      <Button
        variant="link"
        type="button"
        @click="resetMessageAndOpenDialog(SelectedDialog.EDIT_PROFILE)"
      >
        {{ $t("authentication.edit") }}
      </Button>
    </div>

    <div class="tw:flex tw:flex-col tw:gap-3">
      <div class="tw:flex tw:items-center tw:gap-2">
        <Mail class="tw:size-4 tw:shrink-0" />
        <div class="tw:flex tw:flex-col">
          <span class="tw:text-muted-foreground tw:text-xs">
            {{ $t("authentication.email") }}
          </span>
          <span>{{ user.email }}</span>
          <span class="tw:text-muted-foreground tw:text-xs">
            {{ $t("authentication.emailManagedBySso") }}
          </span>
        </div>
      </div>
      <div class="tw:flex tw:items-center tw:justify-between tw:gap-2">
        <div class="tw:flex tw:items-center tw:gap-2">
          <KeyRound class="tw:size-4 tw:shrink-0" />
          <div class="tw:flex tw:flex-col">
            <span class="tw:text-muted-foreground tw:text-xs">
              {{ $t("authentication.password") }}
            </span>
            <span>************</span>
          </div>
        </div>
        <Button variant="link" type="button" @click="openAccountConsole">
          {{ $t("authentication.manageAccount") }}
          <ExternalLink />
        </Button>
      </div>
    </div>

    <div
      class="tw:text-muted-foreground tw:flex tw:flex-col tw:gap-1 tw:text-sm"
    >
      <span
        >{{ $t("general.createdOn") }}:
        {{ getLocaleDate(user.createdAt) }}</span
      >
      <span>
        {{ $t("general.lastModifiedOn") }}: {{ getLocaleDate(user.modifiedAt) }}
      </span>
    </div>

    <div v-if="projects.length > 0" class="tw:flex tw:flex-col tw:gap-2">
      <Separator />
      <h3 class="tw:font-semibold">{{ $t("authentication.projects") }}</h3>
      <TooltipProvider>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{{ $t("authentication.name") }}</TableHead>
              <TableHead>{{ $t("authentication.version") }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              v-for="project in projects"
              :key="'project-' + project.id"
            >
              <TableCell>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="link"
                      type="button"
                      class="tw:h-auto tw:p-0"
                      @click="openProject(project.id)"
                    >
                      <Folder />
                      {{ project.name }}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {{ $t("authentication.openProject") }}
                  </TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell class="tw:whitespace-nowrap">
                {{ store.getActiveVersionForProject(project.id).name }}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TooltipProvider>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { SelectedDialog, useAppStore } from "@/store/app";
import { Project } from "@/types/project";
import { UserData } from "@/types/user";
import { Message } from "@/components/Authentication/AuthenticationDialog.vue";
import { getProjects } from "@/api/projects";
import { getCurrentUser } from "@/api/users";
import { accountConsoleUrl } from "@/auth/config";
import {
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Folder,
  KeyRound,
  Mail,
  X
} from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";

export default defineComponent({
  name: "ProfileDialog",

  components: {
    Alert,
    AlertDescription,
    Button,
    CircleAlert,
    CircleCheck,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    ExternalLink,
    Folder,
    KeyRound,
    Mail,
    Separator,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
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
      store: useAppStore(),
      projects: [] as Project[],
      SelectedDialog: SelectedDialog,
      user: {} as UserData
    };
  },

  async mounted() {
    this.fetchProjects();
    if (this.store.getUserToken() != null) this.user = await getCurrentUser();
  },

  methods: {
    resetMessageAndOpenDialog(selected: SelectedDialog) {
      this.$emit("showMessage", { message: "", type: "error" } as Message);
      this.openDialog(selected);
    },
    closeDialog() {
      this.store.setSelectedDialog(SelectedDialog.NONE);
    },
    openDialog(dialog: SelectedDialog) {
      this.store.setSelectedDialog(dialog);
    },
    /** Password & co. are managed by Keycloak in its account console. */
    openAccountConsole() {
      window.open(accountConsoleUrl, "_blank", "noopener,noreferrer");
    },
    getLocaleDate(date: string): string {
      const locales =
        this.store.getSelectedLanguage() === "de" ? "de-DE" : "en-US";
      return new Date(date).toLocaleDateString(locales);
    },
    openProject(id: number) {
      this.closeDialog();
      this.store.setSelectedProjectId(id);
      this.$router.push("/ProcessList").then(() => window.location.reload());
    },
    fetchProjects() {
      getProjects().then((projects: Project[]) => {
        const sortProjectsByActiveFirstThenAlphabetically = (
          project1: Project,
          project2: Project
        ): number => {
          if (project1.id === this.store.selectedProjectId) return -1;
          if (project2.id === this.store.selectedProjectId) return 1;

          return project1.name.localeCompare(project2.name);
        };

        this.projects = projects.sort(
          sortProjectsByActiveFirstThenAlphabetically
        );
      });
    },
    removeMessage() {
      this.$emit("removeMessage");
    }
  }
});
</script>
