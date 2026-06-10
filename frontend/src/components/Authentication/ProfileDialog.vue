<template>
  <div class="flex flex-col gap-4">
    <DialogHeader>
      <div class="flex items-center justify-between">
        <DialogTitle>{{ $t("general.myProfile") }}</DialogTitle>
        <Button variant="ghost" size="icon" type="button" @click="closeDialog">
          <X />
          <span class="sr-only">{{ $t("general.close") }}</span>
        </Button>
      </div>
    </DialogHeader>

    <Separator />

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

    <div class="flex items-center justify-between">
      <span class="font-semibold">
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

    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2">
        <Mail class="size-4 shrink-0" />
        <div class="flex flex-col">
          <span class="text-muted-foreground text-xs">
            {{ $t("authentication.email") }}
          </span>
          <span>{{ user.email }}</span>
        </div>
      </div>
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <KeyRound class="size-4 shrink-0" />
          <div class="flex flex-col">
            <span class="text-muted-foreground text-xs">
              {{ $t("authentication.password") }}
            </span>
            <span>************</span>
          </div>
        </div>
        <Button
          variant="link"
          type="button"
          @click="resetMessageAndOpenDialog(SelectedDialog.CHANGE_PW)"
        >
          {{ $t("authentication.changePassword") }}
        </Button>
      </div>
    </div>

    <div class="text-muted-foreground flex flex-col gap-1 text-sm">
      <span
        >{{ $t("general.createdOn") }}:
        {{ getLocaleDate(user.createdAt) }}</span
      >
      <span>
        {{ $t("general.lastModifiedOn") }}: {{ getLocaleDate(user.modifiedAt) }}
      </span>
    </div>

    <div v-if="projects.length > 0" class="flex flex-col gap-2">
      <Separator />
      <h3 class="font-semibold">{{ $t("authentication.projects") }}</h3>
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
                      class="h-auto p-0"
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
              <TableCell class="whitespace-nowrap">
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
import {
  CircleAlert,
  CircleCheck,
  Folder,
  KeyRound,
  Mail,
  X
} from "@lucide/vue";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
    DialogHeader,
    DialogTitle,
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
