<template>
  <div class="tw:flex tw:items-center tw:gap-4 tw:border-b tw:px-6 tw:py-4">
    <span class="tw:text-lg tw:font-medium">{{ selectedProjectName }}</span>
    <span class="tw:text-muted-foreground tw:text-sm">
      VERSION {{ selectedVersionName }}
    </span>
  </div>

  <ProcessDetailDialog ref="processDetailDialog" />

  <div
    v-if="isFetching"
    class="tw:flex tw:h-3/4 tw:w-full tw:items-center tw:justify-center"
  >
    <div class="tw:flex tw:flex-col tw:items-center tw:justify-center tw:gap-2">
      <span>{{ $t("processList.fetchingProcessModels") }}</span>
      <Loader2 class="tw:size-6 tw:animate-spin" />
    </div>
  </div>

  <div v-else class="tw:p-6">
    <p v-if="rootProcessModels.length == 0">
      {{ $t("processList.noProcessModelsFound") }}
    </p>
    <template
      v-for="(model, index) in rootProcessModels"
      :key="'process-' + model.id"
    >
      <ProcessTreeNode
        :model="model"
        :index="index"
        @delete-process="deleteProcessModel"
        @upload-process="openSingleUploadDialog"
        @more-info="showProcessInfoDialog"
      />
      <Separator v-if="index < rootProcessModels.length - 1" />
    </template>
  </div>

  <TooltipProvider>
    <div class="tw:fixed tw:right-4 tw:bottom-4 tw:z-10 tw:flex tw:gap-4">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            size="icon-lg"
            type="button"
            class="tw:rounded-full tw:shadow-lg"
            @click="goToC8Import"
          >
            <Cloud />
            <span class="tw:sr-only">
              {{ $t("processList.navigateToC8Import") }}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {{ $t("processList.navigateToC8Import") }}
        </TooltipContent>
      </Tooltip>

      <Button
        size="icon-lg"
        type="button"
        class="tw:rounded-full tw:shadow-lg"
        @click="openMultipleUploadDialog"
      >
        <Plus />
        <span class="tw:sr-only">
          {{ $t("processList.uploadProcessModels") }}
        </span>
      </Button>
    </div>
  </TooltipProvider>

  <div
    v-if="rootProcessModels.length > 0"
    class="tw:fixed tw:right-4 tw:bottom-4 tw:left-4 tw:flex tw:items-center tw:justify-center"
  >
    <Button variant="outline" type="button" @click="goToProcessMap">
      <MapIcon />
      {{ $t("processList.toTheProcessMap") }}
    </Button>
  </div>

  <Dialog v-model:open="uploadDialog">
    <DialogContent
      class="tw:sm:max-w-[600px]"
      @escape-key-down="preventDialogClose"
      @pointer-down-outside="preventDialogClose"
      @interact-outside="preventDialogClose"
      @close-auto-focus="resetUploadDialog"
    >
      <DialogHeader>
        <DialogTitle>
          <span v-if="uploadDialogMode === 'multiple'">
            {{ $t("processList.uploadProcessModels") }}
          </span>
          <span v-if="uploadDialogMode === 'single'">
            {{ $t("processList.replaceProcessModel") }}
          </span>
        </DialogTitle>
      </DialogHeader>

      <div class="tw:flex tw:flex-col tw:gap-4">
        <div class="tw:flex tw:flex-col tw:gap-1.5">
          <Label for="process-model-files">
            {{
              uploadDialogMode === "multiple"
                ? $t("processList.processModels")
                : $t("general.processModel")
            }}
          </Label>
          <input
            id="process-model-files"
            ref="fileInput"
            type="file"
            :multiple="uploadDialogMode === 'multiple'"
            class="tw:file:text-foreground tw:placeholder:text-muted-foreground tw:border-input tw:flex tw:h-9 tw:w-full tw:min-w-0 tw:rounded-md tw:border tw:bg-transparent tw:px-3 tw:py-1 tw:text-sm tw:shadow-xs tw:transition-[color,box-shadow] tw:outline-none tw:file:mr-3 tw:file:inline-flex tw:file:h-7 tw:file:border-0 tw:file:bg-transparent tw:file:text-sm tw:file:font-medium tw:focus-visible:border-ring tw:focus-visible:ring-ring/50 tw:focus-visible:ring-3"
            @change="onFileInputChange"
          />
        </div>

        <div
          v-for="(file, index) in processModelsToUpload"
          :key="'file-' + index"
          class="tw:flex tw:flex-col tw:gap-2"
        >
          <div class="tw:flex tw:items-center tw:gap-2">
            <p class="tw:font-medium">{{ file.file.name }}</p>
            <span
              v-if="file.isCollaboration"
              class="tw:text-muted-foreground tw:text-sm"
            >
              {{ $t("processList.collaboration") }}
            </span>
          </div>
          <div class="tw:flex tw:flex-col tw:gap-1.5">
            <Label :for="'file-name-' + index">Name</Label>
            <Input :id="'file-name-' + index" v-model="file.name" />
          </div>
          <div class="tw:flex tw:flex-col tw:gap-1.5">
            <Label :for="'file-description-' + index">
              {{ $t("general.description") }}
            </Label>
            <Textarea
              :id="'file-description-' + index"
              v-model="file.description"
              rows="3"
            />
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" type="button" @click="closeUploadDialog">
          {{ $t("general.cancel") }}
        </Button>
        <Button
          v-if="uploadDialogMode === 'multiple'"
          type="button"
          @click="uploadProcessModels"
        >
          {{ $t("general.save") }}
        </Button>
        <Button
          v-if="uploadDialogMode === 'single'"
          type="button"
          @click="replaceProcessModel"
        >
          {{ $t("general.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="progressDialog">
    <DialogContent class="tw:sm:max-w-[600px]">
      <DialogHeader>
        <DialogTitle>Upload</DialogTitle>
      </DialogHeader>
      <div class="tw:flex tw:flex-col tw:gap-3">
        <p>
          {{ $t("processList.uploadingProcessModel") }}:
          {{ currentlyUploadingProcessModel.name }} ({{ currentUploadStatus }})
        </p>
        <Progress :model-value="progress" />
      </div>
      <DialogFooter>
        <Button variant="ghost" type="button" @click="progressDialog = false">
          {{ $t("general.cancel") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="confirmDeleteDialog">
    <DialogContent class="tw:sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle class="tw:flex tw:items-center tw:gap-2">
          <Trash2 class="tw:size-5" />
          {{ $t("processList.confirmDeletion") }}
        </DialogTitle>
        <DialogDescription>
          {{ $t("processList.confirmDeletionText1")
          }}<strong>{{ processModelToBeDeleted?.processName }}</strong
          >{{ $t("processList.confirmDeletionText2") }}
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
        <Button
          variant="destructive"
          type="button"
          @click="deleteProcessModel(processModelToBeDeleted!, true)"
        >
          {{ $t("processList.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="errorDialog">
    <DialogContent class="tw:sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle class="tw:flex tw:items-center tw:gap-2">
          <AlertCircle class="tw:size-5" />
          {{ $t("processList.error") }}
        </DialogTitle>
        <DialogDescription>{{ errorMessage }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" type="button" @click="errorDialog = false">
          {{ $t("general.close") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script lang="ts">
import ProcessDetailDialog from "@/components/ProcessDetailDialog.vue";
import { defineComponent } from "vue";
import { useAppStore } from "@/store/app";
import { getProject } from "@/api/projects";
import * as processModelsApi from "@/api/processModels";
import ProcessTreeNode from "@/components/ProcessList/ProcessTreeNode.vue";
import {
  ProcessModelInformation,
  ProcessModelNode
} from "@/types/processModel";
import { getErrorMessage } from "@/api/errors";
import {
  AlertCircle,
  Cloud,
  Loader2,
  Map as MapIcon,
  Plus,
  Trash2
} from "@lucide/vue";
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
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";

interface BPMNContent {
  name: string;
  description: string;
  isCollaboration: boolean;
}

enum UploadDialogMode {
  SINGLE = "single",
  MULTIPLE = "multiple"
}

interface ProcessModelToUpload {
  file: File;
  name: string;
  description: string;
  content: string;
  isCollaboration: boolean;
}

export default defineComponent({
  components: {
    ProcessTreeNode,
    ProcessDetailDialog,
    AlertCircle,
    Button,
    Cloud,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Loader2,
    MapIcon,
    Plus,
    Progress,
    Separator,
    Textarea,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    Trash2
  },
  data: () => ({
    appStore: useAppStore(),
    confirmDeleteDialog: false as boolean,
    errorDialog: false as boolean,
    errorMessage: "" as string,
    uploadDialog: false as boolean,
    uploadDialogMode: UploadDialogMode.MULTIPLE as UploadDialogMode,
    processModelToBeReplacedId: null as number | null,
    processModelToBeDeleted: null as ProcessModelNode | null,
    progressDialog: false,
    progress: 0,
    processModelFiles: [] as File[],
    processModelsToUpload: [] as ProcessModelToUpload[],
    rootProcessModels: [] as ProcessModelNode[],
    selectedProjectId: null as number | null,
    selectedProjectName: "" as string,
    selectedVersionName: "" as string,
    selectedVersionId: null as number | null,
    fileExtensionMatcher: /.[^/.]+$/,
    isFetching: false as boolean,
    currentlyUploadingProcessModel: {} as ProcessModelToUpload,
    currentUploadStatus: "" as string
  }),
  computed: {
    isUserLoggedIn(): boolean {
      return this.appStore.getUserToken() != null;
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
    this.selectedProjectId = this.appStore.selectedProjectId;
    if (!this.selectedProjectId) {
      this.$router.push("/");
      return;
    }
    getProject(this.selectedProjectId).then((project) => {
      this.selectedProjectName = project.name;
      this.selectedVersionName = this.appStore.getActiveVersionForProject(
        this.selectedProjectId!
      ).name;
      this.selectedVersionId = this.appStore.getActiveVersionForProject(
        this.selectedProjectId!
      ).id;

      this.fetchProcessModels();
    });
  },
  methods: {
    /** The original dialog was `persistent`: it ignored ESC and
     * outside clicks. */
    preventDialogClose(event: Event) {
      event.preventDefault();
    },

    onFileInputChange(event: Event) {
      const target = event.target as HTMLInputElement;
      this.processModelFiles = target.files ? Array.from(target.files) : [];
      this.handleFileSelection();
    },

    showProcessInfoDialog(processId: number) {
      (
        this.$refs.processDetailDialog as InstanceType<
          typeof ProcessDetailDialog
        >
      ).showProcessInfoDialog(processId);
    },

    async deleteProcessModel(
      processModelNode: ProcessModelNode,
      skipConfirm: boolean = false
    ) {
      const isParticipant = processModelNode.processType === "PARTICIPANT";
      if (!skipConfirm && isParticipant) {
        this.processModelToBeDeleted = processModelNode;
        this.confirmDeleteDialog = true;
        return;
      }
      const processId = processModelNode.id;
      await processModelsApi.deleteProcessModel(processId).then(() => {
        this.confirmDeleteDialog = false;
        this.processModelToBeDeleted = null;
        this.appStore.setProcessModelsChanged();
        this.fetchProcessModels();
      });
    },

    fetchProcessModels() {
      this.isFetching = true;
      processModelsApi
        .getProcessModels(this.selectedVersionId!)
        .then((processModels) => {
          this.rootProcessModels = this.collectRoots(processModels);
          this.isFetching = false;
        });
    },

    collectRoots(
      processModelInformation: ProcessModelInformation[]
    ): ProcessModelNode[] {
      const modelMap = new Map<number, ProcessModelInformation>();
      processModelInformation.forEach((model) => modelMap.set(model.id, model));
      return processModelInformation
        .filter((model) => model.processType !== "PARTICIPANT")
        .map((model) => {
          if (model.processType === "COLLABORATION") {
            const children = model.childrenIds.map((id) => modelMap.get(id)!);
            const childrenAsNodes = children.map((child) => ({
              ...child,
              children: []
            }));
            return { ...model, children: childrenAsNodes };
          } else {
            return { ...model, children: [] };
          }
        });
    },

    openSingleUploadDialog(modelId: number) {
      this.uploadDialog = true;
      this.uploadDialogMode = UploadDialogMode.SINGLE;
      this.processModelToBeReplacedId = modelId;
    },

    openMultipleUploadDialog() {
      this.uploadDialog = true;
      this.uploadDialogMode = UploadDialogMode.MULTIPLE;
    },

    async readFileContent(file: File): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
          const result = reader.result;
          if (typeof result === "string") {
            resolve(result);
          } else {
            reject(new Error("File content is not a string"));
          }
        };

        reader.onerror = () => {
          reject(new Error("Error reading file"));
        };

        reader.readAsText(file);
      });
    },

    parseBPMNContent(content: string): BPMNContent {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(content, "text/xml");

      const isCollaboration =
        xmlDoc.getElementsByTagName("bpmn:process")?.length > 1 ||
        xmlDoc.getElementsByTagName("semantic:process")?.length > 1 ||
        xmlDoc.getElementsByTagName("process")?.length > 1;

      if (isCollaboration) {
        const collaboration =
          xmlDoc.querySelector("bpmn\\:collaboration") ||
          xmlDoc.querySelector("semantic\\:collaboration") ||
          xmlDoc.querySelector("collaboration");

        const name = collaboration?.getAttribute("name") || "";
        const documentation =
          collaboration?.querySelector("bpmn\\:documentation") ||
          collaboration?.querySelector("semantic\\:documentation") ||
          collaboration?.querySelector("documentation");

        const description = documentation?.getAttribute("textContent") || "";
        return { name, description, isCollaboration };
      }

      const process =
        xmlDoc.querySelector("bpmn\\:process") ||
        xmlDoc.querySelector("semantic\\:process") ||
        xmlDoc.querySelector("process");

      const name = process?.getAttribute("name") || "";

      const documentation =
        process?.querySelector("bpmn\\:documentation") ||
        process?.querySelector("semantic\\:documentation") ||
        process?.querySelector("documentation");

      const description = documentation?.getAttribute("textContent") || "";

      return { name, description, isCollaboration };
    },

    async handleFileSelection() {
      this.processModelsToUpload = [];

      for (const file of this.processModelFiles) {
        try {
          this.processModelsToUpload.push(
            await this.getProcessModelToUpload(file)
          );
        } catch (error) {
          console.error("Error reading file content: ", error);
        }
      }
    },

    async getProcessModelToUpload(file: File): Promise<ProcessModelToUpload> {
      const content = await this.readFileContent(file);

      const { name, description, isCollaboration } =
        this.parseBPMNContent(content);
      return {
        file,
        name: name || file.name.replace(this.fileExtensionMatcher, ""),
        description,
        content,
        isCollaboration
      };
    },

    async uploadProcessModel(
      processModel: ProcessModelToUpload
    ): Promise<number> {
      return await processModelsApi.uploadProcessModel(
        this.selectedVersionId!,
        this.toProcessModelUpload(processModel)
      );
    },

    toProcessModelUpload(
      processModel: ProcessModelToUpload
    ): processModelsApi.ProcessModelUpload {
      const fileName =
        processModel.name ||
        processModel.file.name.replace(this.fileExtensionMatcher, "");
      return {
        file: processModel.file,
        fileName,
        description: processModel.description,
        isCollaboration: processModel.isCollaboration
      };
    },

    async uploadProcessModels() {
      if (this.processModelsToUpload.length > 0) {
        this.progressDialog = true;
        const progressSteps = 100 / (this.processModelsToUpload.length * 2);

        const numProcessModels = this.processModelsToUpload.length;
        let i = 0;
        for (const processModel of this.processModelsToUpload) {
          this.progress += progressSteps;
          this.currentlyUploadingProcessModel = processModel;
          i += 1;
          this.currentUploadStatus = `${i}/${numProcessModels}`;

          try {
            await this.uploadProcessModel(processModel);
          } catch (error) {
            this.afterUploadActions();
            this.errorMessage = getErrorMessage(error);
            this.errorDialog = true;
            return;
          }

          this.progress += progressSteps;
        }

        this.afterUploadActions();
      }
    },

    async replaceProcessModel() {
      if (this.processModelsToUpload.length !== 1) {
        return;
      }

      try {
        await processModelsApi.replaceProcessModel(
          this.selectedVersionId!,
          this.processModelToBeReplacedId!,
          this.toProcessModelUpload(this.processModelsToUpload[0])
        );
      } catch (error) {
        this.afterUploadActions();
        this.errorMessage = getErrorMessage(error);
        this.errorDialog = true;
        return;
      }

      this.afterUploadActions();
    },

    afterUploadActions() {
      this.fetchProcessModels();
      this.progressDialog = false;
      this.progress = 0;
      this.closeUploadDialog();
      this.appStore.setProcessModelsChanged();
    },

    closeUploadDialog() {
      this.uploadDialog = false;
    },

    resetUploadDialog() {
      this.processModelFiles = [];
      this.processModelsToUpload = [];
      this.progressDialog = false;
      this.processModelToBeReplacedId = null;
      this.progress = 0;
      const fileInput = this.$refs.fileInput as HTMLInputElement | undefined;
      if (fileInput) {
        fileInput.value = "";
      }
    },

    goToC8Import() {
      this.$router.push("CamundaCloudImport");
    },
    getLocaleDate(date: string): string {
      const locales =
        this.appStore.getSelectedLanguage() === "de" ? "de-DE" : "en-US";
      return new Date(date).toLocaleString(locales);
    },
    goToProcessMap() {
      this.$router.push("ProcessMap");
    }
  }
});
</script>
