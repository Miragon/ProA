<template>
  <div
    class="tw:bg-background tw:flex tw:h-16 tw:items-center tw:border-b tw:px-4"
  >
    <span class="tw:text-lg">{{ selectedProjectName }}</span>
    <span class="tw:text-muted-foreground tw:ml-4 tw:text-sm"
      >VERSION {{ selectedVersionName }}</span
    >
  </div>
  <div class="tw:flex tw:flex-col tw:p-6">
    <div v-if="importedProcessModels.length > 0">
      <div class="tw:flex tw:items-center tw:gap-3 tw:py-2">
        <Checkbox
          id="select-all"
          :model-value="selectAll"
          @update:model-value="onSelectAllChange"
        />
        <Label for="select-all" class="tw:font-normal">
          {{ $t("c8Import.selectAll") }}
        </Label>
      </div>
      <Separator />
    </div>
    <template
      v-for="(model, index) in processModels"
      :key="'process-' + model.id"
    >
      <div class="tw:flex tw:items-center tw:gap-3 tw:py-2">
        <Checkbox
          :id="'process-checkbox-' + model.id"
          :model-value="selectedProcessModels.includes(model)"
          @update:model-value="onModelChange(model, $event)"
        />
        <Label
          :for="'process-checkbox-' + model.id"
          class="tw:flex tw:flex-col tw:items-start tw:gap-0.5 tw:font-normal"
        >
          <span>{{ model.name }}</span>
          <span class="tw:text-muted-foreground tw:text-xs">
            {{ getLocaleDate(model.created) }} - {{ model.updatedBy.email }}
          </span>
        </Label>
      </div>
      <Separator v-if="index < processModels.length - 1" />
    </template>
  </div>
  <Dialog v-model:open="camundaCloudDialog">
    <DialogContent
      class="tw:sm:max-w-[600px]"
      @escape-key-down="preventEscapeClose"
    >
      <DialogHeader>
        <DialogTitle>{{ $t("c8Import.importFromC8") }}</DialogTitle>
        <DialogDescription class="tw:sr-only">
          {{ $t("c8Import.importFromC8") }}
        </DialogDescription>
      </DialogHeader>
      <div class="tw:flex tw:flex-col tw:gap-4">
        <div v-if="!!token" class="tw:flex tw:items-center tw:gap-2">
          <CheckCircle class="tw:size-5 tw:text-green-600" />
          {{ $t("c8Import.camundaConnectionSuccessMessage") }}
        </div>
        <Input
          v-if="!token"
          v-model="settings.modelerClientId"
          :placeholder="$t('general.clientId')"
        />
        <div v-if="!token" class="tw:relative">
          <Input
            v-model="settings.modelerClientSecret"
            :type="showOperateClientSecret ? 'text' : 'password'"
            :placeholder="$t('general.clientSecret')"
            class="tw:pr-10"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            class="tw:absolute tw:top-0 tw:right-0 tw:h-9 tw:w-9"
            @click="showOperateClientSecret = !showOperateClientSecret"
          >
            <Eye v-if="showOperateClientSecret" />
            <EyeOff v-else />
          </Button>
        </div>
        <div v-if="!token" class="tw:flex tw:items-center tw:gap-2">
          <Checkbox id="save-client-info" v-model="saveClientInformation" />
          <Label for="save-client-info" class="tw:font-normal">
            {{ $t("c8Import.saveInformationQuestion") }}
          </Label>
        </div>
        <div v-if="tokenError" class="tw:text-destructive">
          {{ $t("c8Import.errorMessage") }}
        </div>
        <div v-if="!token">
          <Button @click="fetchToken">
            {{ $t("c8Import.connect") }}
          </Button>
        </div>
        <div class="tw:flex tw:flex-col tw:gap-1">
          <Input
            v-model="creatorEmail"
            :disabled="!token"
            :placeholder="$t('c8Import.creatorEmail')"
          />
          <span class="tw:text-muted-foreground tw:text-xs">
            {{ $t("c8Import.creatorEmailHint") }}
          </span>
        </div>
        <div>
          <Button :disabled="!token" @click="fetchProcessModels">
            {{ $t("c8Import.retrieveProcessModels") }}
          </Button>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="camundaCloudDialog = false">
          {{ $t("general.cancel") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  <Dialog v-model:open="loadingDialog">
    <DialogContent
      class="tw:sm:max-w-[320px]"
      :show-close-button="false"
      @escape-key-down="preventEscapeClose"
      @pointer-down-outside="preventOutsideClose"
    >
      <DialogHeader>
        <DialogTitle class="tw:sr-only">{{
          $t("c8Import.loading")
        }}</DialogTitle>
      </DialogHeader>
      <div class="tw:flex tw:items-center tw:justify-between tw:gap-2">
        <span>{{ $t("c8Import.loading") }}</span>
        <Loader2 class="tw:size-4 tw:animate-spin" />
      </div>
    </DialogContent>
  </Dialog>
  <div class="tw:fixed tw:right-2 tw:bottom-2 tw:z-[1]">
    <Button size="icon-lg" class="tw:shadow-lg" @click="openDialog">
      <CloudCog />
    </Button>
  </div>
  <div
    v-if="selectedProcessModels.length > 0"
    class="tw:fixed tw:right-2 tw:bottom-2 tw:left-2 tw:flex tw:h-14 tw:items-center tw:justify-center"
  >
    <Button @click="importProcessModels">
      <Import />
      {{ $t("c8Import.importProcessModels") }}
    </Button>
  </div>
  <div
    v-if="importedProcessModels.length > 0"
    class="tw:fixed tw:right-2"
    :style="{ top: stickyButtonTop + 'px' }"
  >
    <Popover>
      <PopoverTrigger as-child>
        <Button size="icon-lg" class="tw:relative tw:shadow-lg">
          <Filter />
          <Badge
            v-if="selectedEmailCount > 0"
            class="tw:absolute tw:-top-1 tw:-right-1 tw:size-4 tw:p-0"
          >
            {{ selectedEmailCount }}
          </Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent class="tw:w-auto tw:p-2">
        <p class="tw:text-muted-foreground tw:px-2 tw:py-1.5 tw:text-sm">
          {{ $t("c8Import.creatorEmail") }}
        </p>
        <div
          v-for="(emailSelection, index) in emailSelections"
          :key="'imported-email-' + index"
          class="tw:flex tw:items-center tw:gap-2 tw:px-2 tw:py-1.5"
        >
          <Checkbox
            :id="'email-' + index"
            :model-value="emailSelection.selected"
            @update:model-value="onEmailSelectionChange(emailSelection, $event)"
          />
          <Label :for="'email-' + index" class="tw:font-normal">
            {{ emailSelection.email }}
          </Label>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>
<script lang="ts">
import { defineComponent } from "vue";
import {
  CheckCircle,
  CloudCog,
  Eye,
  EyeOff,
  Filter,
  Import,
  Loader2
} from "@lucide/vue";
import { useAppStore } from "@/store/app";
import { getProject } from "@/api/projects";
import { getSettings, persistSettings } from "@/api/settings";
import * as camundaCloudApi from "@/api/camundaCloud";
import { Settings } from "@/types/settings";
import { CamundaProcessModel as ProcessModel } from "@/types/camundaCloud";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";

interface EmailSelection {
  email: string;
  selected: boolean;
}

const minStickyOffset = 72;
const maxStickyOffset = 136;

export default defineComponent({
  components: {
    Badge,
    Button,
    CheckCircle,
    Checkbox,
    CloudCog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Eye,
    EyeOff,
    Filter,
    Import,
    Input,
    Label,
    Loader2,
    Popover,
    PopoverContent,
    PopoverTrigger,
    Separator
  },

  data: () => ({
    store: useAppStore(),
    showOperateClientSecret: false as boolean,
    camundaCloudDialog: false as boolean,
    loadingDialog: false as boolean,
    settings: {} as Settings,
    saveClientInformation: true as boolean,
    // shadcn `Input` v-model is typed `string | number`; the empty string is
    // treated as blank by `isBlank`, so `fetchProcessModels` still sends `null`
    // (preserving the previous behaviour when the field was left empty).
    creatorEmail: "" as string,
    clientId: "" as string,
    clientSecret: "" as string,
    importedProcessModels: [] as ProcessModel[],
    processModels: [] as ProcessModel[],
    selectedProcessModels: [] as ProcessModel[],
    tokenError: false as boolean,
    token: null as string | null,
    selectedProjectId: null as number | null,
    selectedProjectName: "" as string,
    selectedVersionId: null as number | null,
    selectedVersionName: "" as string,
    selectAll: false as boolean,
    emailSelections: [] as EmailSelection[],
    stickyButtonTop: Math.max(minStickyOffset, maxStickyOffset - scrollY)
  }),

  computed: {
    isUserLoggedIn(): boolean {
      return this.store.getUserToken() != null;
    },
    selectedEmailCount(): number {
      return this.emailSelections.filter(
        (emailSelection) => emailSelection.selected
      ).length;
    }
  },

  watch: {
    isUserLoggedIn(newValue) {
      if (!newValue) {
        this.$router.push("/");
      }
    }
  },

  mounted: function () {
    this.selectedProjectId = this.store.getSelectedProjectId();
    const selectedProjectId = this.selectedProjectId;
    if (!selectedProjectId) {
      this.$router.push("/");
      return;
    }
    getProject(selectedProjectId).then((project) => {
      this.selectedProjectName = project.name;
      const activeVersion =
        this.store.getActiveVersionForProject(selectedProjectId);
      this.selectedVersionId = activeVersion.id;
      this.selectedVersionName = activeVersion.name;
    });
    window.addEventListener("scroll", this.updateStickyButton);
    this.fetchSettings();
  },
  beforeUnmount() {
    window.removeEventListener("scroll", this.updateStickyButton);
  },
  methods: {
    async openDialog() {
      this.showOperateClientSecret = false;
      await this.fetchSettings();
      this.camundaCloudDialog = true;
    },
    fetchToken() {
      this.loadingDialog = true;
      camundaCloudApi
        .fetchToken(
          this.settings.modelerClientId,
          this.settings.modelerClientSecret
        )
        .then((token) => {
          this.token = token;
          this.tokenError = false;
          this.loadingDialog = false;
        })
        .catch(() => {
          this.tokenError = true;
          this.loadingDialog = false;
        });
    },
    async fetchProcessModels() {
      this.loadingDialog = true;
      camundaCloudApi
        .fetchProcessModels({
          token: this.token,
          email: this.isBlank(this.creatorEmail) ? null : this.creatorEmail,
          regionId: null,
          clusterId: null
        })
        .then(async (processModels) => {
          if (this.saveClientInformation) {
            await this.saveSettings();
          }
          this.processModels = processModels;
          this.importedProcessModels = processModels;
          this.emailSelections = [
            ...new Set(
              processModels.map((processModel) => processModel.updatedBy.email)
            )
          ]
            .sort()
            .map((email) => ({
              email,
              selected: false
            }));
          this.camundaCloudDialog = false;
          this.loadingDialog = false;
        })
        .catch(() => {
          this.tokenError = true;
          this.token = null;
          this.loadingDialog = false;
        });
    },
    importProcessModels() {
      this.loadingDialog = true;
      const selectedProcessModelIds: string[] = this.selectedProcessModels.map(
        (model) => {
          return model.id;
        }
      );

      camundaCloudApi
        .importProcessModels(
          // The backend import endpoint expects a project VERSION id.
          this.selectedVersionId!,
          this.token,
          selectedProcessModelIds
        )
        .then(() => {
          this.processModels = this.processModels.filter(
            (model) => !selectedProcessModelIds.includes(model.id)
          );
          this.selectedProcessModels = [];
          this.loadingDialog = false;
          this.store.setProcessModelsChanged();
          this.$router.push("/ProcessList");
        })
        .catch((error) => {
          console.log(error);
          this.loadingDialog = false;
        });
    },
    async fetchSettings() {
      try {
        this.settings = (await getSettings()) ?? ({} as Settings);
      } catch {
        this.settings = {} as Settings;
      }

      this.settings.modelerClientId =
        this.settings?.modelerClientId ||
        import.meta.env.VITE_MODELER_CLIENT_ID;
      this.settings.modelerClientSecret =
        this.settings?.modelerClientSecret ||
        import.meta.env.VITE_MODELER_CLIENT_SECRET;
    },
    async saveSettings() {
      await persistSettings(this.settings);
    },
    getLocaleDate(date: string): string {
      const locales =
        this.store.getSelectedLanguage() === "de" ? "de-DE" : "en-US";
      return new Date(date).toLocaleString(locales);
    },
    preventEscapeClose(event: KeyboardEvent) {
      event.preventDefault();
    },
    preventOutsideClose(event: Event) {
      event.preventDefault();
    },
    onSelectAllChange(value: boolean | "indeterminate") {
      this.selectAll = value === true;
      this.toggleSelectAll();
    },
    onModelChange(model: ProcessModel, value: boolean | "indeterminate") {
      if (value === true) {
        if (!this.selectedProcessModels.includes(model)) {
          this.selectedProcessModels.push(model);
        }
      } else {
        this.selectedProcessModels = this.selectedProcessModels.filter(
          (selected) => selected !== model
        );
      }
    },
    onEmailSelectionChange(
      emailSelection: EmailSelection,
      value: boolean | "indeterminate"
    ) {
      emailSelection.selected = value === true;
      this.filterSelectedModels();
    },
    toggleSelectAll() {
      if (this.selectAll) {
        this.selectedProcessModels = this.processModels;
      } else {
        this.selectedProcessModels = [];
      }
    },
    filterSelectedModels() {
      const selectedEmails = this.emailSelections
        .filter((emailSelection) => emailSelection.selected)
        .map((emailSelection) => emailSelection.email);
      if (selectedEmails.length == 0) {
        this.processModels = this.importedProcessModels;
        this.updateSelectAll();
        return;
      }
      this.processModels = this.importedProcessModels.filter((model) =>
        selectedEmails.includes(model.updatedBy.email)
      );
      this.selectedProcessModels = this.selectedProcessModels.filter((model) =>
        selectedEmails.includes(model.updatedBy.email)
      );
      this.updateSelectAll();
    },
    updateSelectAll() {
      this.selectAll =
        this.selectedProcessModels.length == this.processModels.length;
    },
    updateStickyButton() {
      this.stickyButtonTop = Math.max(
        minStickyOffset,
        maxStickyOffset - scrollY
      );
    },
    isBlank(s: string | null) {
      return !s || /^\s*$/.test(s);
    }
  }
});
</script>
<style scoped></style>
