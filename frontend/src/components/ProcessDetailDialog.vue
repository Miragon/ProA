<template>
  <Dialog v-model:open="infoDialog">
    <DialogContent
      class="tw:max-h-[90vh] tw:overflow-y-auto tw:sm:max-w-[600px]"
      @escape-key-down="preventEscapeClose"
    >
      <DialogHeader>
        <DialogTitle>
          {{ $t("general.processModel") }}: {{ details.name }}
        </DialogTitle>
        <DialogDescription class="tw:sr-only">
          {{ $t("general.processModel") }}
        </DialogDescription>
      </DialogHeader>

      <div class="tw:grid tw:grid-cols-1 tw:gap-4 tw:sm:grid-cols-2">
        <div v-if="details.startEvents && details.startEvents.length > 0">
          <b>{{ $t("processDetailSidebar.startEvents") }}</b>
          <ul class="tw:mt-1 tw:flex tw:flex-col tw:gap-2">
            <li
              v-for="(start, index) in details.startEvents"
              :key="'startEvent-' + index"
            >
              <Badge
                class="tw:cursor-pointer"
                @click="goToProcessModel(start.elementId)"
              >
                {{ start.label || "Start" }}
              </Badge>
            </li>
          </ul>
        </div>
        <div v-if="details.endEvents && details.endEvents.length > 0">
          <b>{{ $t("processDetailSidebar.endEvents") }}</b>
          <ul class="tw:mt-1 tw:flex tw:flex-col tw:gap-2">
            <li
              v-for="(end, index) in details.endEvents"
              :key="'endEvent-' + index"
            >
              <Badge
                class="tw:cursor-pointer"
                @click="goToProcessModel(end.elementId)"
              >
                {{ end.label || $t("general.end") }}
              </Badge>
            </li>
          </ul>
        </div>
        <div
          v-if="
            details.intermediateCatchEvents &&
            details.intermediateCatchEvents.length > 0
          "
        >
          <b>{{ $t("general.intermediateCatchEvents") }}</b>
          <ul class="tw:mt-1 tw:flex tw:flex-col tw:gap-2">
            <li
              v-for="(event, index) in details.intermediateCatchEvents"
              :key="'intermediateCatchEvent-' + index"
            >
              <Badge
                class="tw:cursor-pointer"
                @click="goToProcessModel(event.elementId)"
              >
                {{ event.label || $t("general.intermediateEvent") }}
              </Badge>
            </li>
          </ul>
        </div>
        <div
          v-if="
            details.intermediateThrowEvents &&
            details.intermediateThrowEvents.length > 0
          "
        >
          <b>{{ $t("general.intermediateThrowEvents") }}</b>
          <ul class="tw:mt-1 tw:flex tw:flex-col tw:gap-2">
            <li
              v-for="(event, index) in details.intermediateThrowEvents"
              :key="'intermediateThrowEvent-' + index"
            >
              <Badge
                class="tw:cursor-pointer"
                @click="goToProcessModel(event.elementId)"
              >
                {{ event.label || $t("general.intermediateEvent") }}
              </Badge>
            </li>
          </ul>
        </div>
        <div v-if="details.activities && details.activities.length > 0">
          <b>{{ $t("general.callActivities") }}</b>
          <ul class="tw:mt-1 tw:flex tw:flex-col tw:gap-2">
            <li
              v-for="(activity, index) in details.activities"
              :key="'activity-' + index"
            >
              <Badge
                class="tw:cursor-pointer"
                @click="goToProcessModel(activity.elementId)"
              >
                {{ activity.label || $t("general.activity") }}
              </Badge>
            </li>
          </ul>
        </div>
      </div>
      <div v-if="details.description" class="tw:flex tw:flex-col tw:gap-2">
        <b>{{ $t("general.description") }}:</b>
        <p class="description-text">{{ details.description }}</p>
      </div>
      <div id="process-model-viewer" class="tw:mt-4"></div>

      <DialogFooter>
        <Button variant="ghost" @click="goToProcessModel(null)">
          {{ $t("general.processModel") }}
        </Button>
        <Button variant="ghost" @click="infoDialog = false">
          {{ $t("general.cancel") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
<script lang="ts">
import { defineComponent } from "vue";
import { dia } from "@joint/core";
import BpmnViewer from "bpmn-js";
import {
  getProcessModelDetails,
  getProcessModelXml
} from "@/api/processModels";
import { ProcessDetails } from "@/types/processModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

interface RouteObject {
  path: string;
  query?: {
    portId: string;
  };
}

export default defineComponent({
  components: {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
  },
  data: () => ({
    infoDialog: false,
    details: {} as ProcessDetails
  }),

  methods: {
    /** The previous Vuetify dialog was `persistent`: ESC did not close it. */
    preventEscapeClose(event: KeyboardEvent) {
      event.preventDefault();
    },
    async showProcessInfoDialog(processId: number) {
      this.infoDialog = true;
      await this.$nextTick();
      this.resetProcessModel();
      await this.fetchProcessModel(processId);
      getProcessModelDetails(processId).then((details) => {
        this.details = details;
      });
    },
    async goToProcessModel(portId: string | null) {
      const routeObject: RouteObject = {
        path: "/ProcessView/" + this.details.id
      };
      if (portId) {
        routeObject.query = { portId };
      }
      this.$router.push(routeObject);
    },
    async fetchProcessModel(modelId: dia.Cell.ID) {
      const viewer = new BpmnViewer({
        container: "#process-model-viewer"
      });

      const xmlText = await getProcessModelXml(modelId);
      await viewer.importXML(xmlText);
      const canvas = viewer.get("canvas") as {
        zoom(newScale: "fit-viewport", center: "auto"): number;
      };
      canvas.zoom("fit-viewport", "auto");
    },
    resetProcessModel() {
      document.getElementById("process-model-viewer")!.innerHTML = "";
    }
  }
});
</script>
<style scoped>
li {
  list-style-type: none;
}

#process-model-viewer {
  height: 20vh;
}

.description-text {
  word-break: break-word;
  white-space: pre-wrap;
}
</style>
