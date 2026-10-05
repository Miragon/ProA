<template>
  <div
    v-if="showSidebar"
    class="tw:bg-background tw:absolute tw:top-0 tw:right-0 tw:bottom-0 tw:z-10 tw:flex tw:w-64 tw:flex-col tw:border-l tw:shadow-lg"
  >
    <div class="tw:flex tw:h-16 tw:shrink-0 tw:items-center tw:px-2">
      <Button variant="ghost" size="icon" @click="close">
        <PanelRightClose />
      </Button>
    </div>
    <div
      v-if="isFetching"
      class="tw:flex tw:h-3/4 tw:w-full tw:items-center tw:justify-center"
    >
      <div class="tw:flex tw:flex-col tw:items-center tw:justify-center">
        <span class="tw:mx-5 tw:mb-2 tw:text-center">{{
          $t("processDetailSidebar.loadingData")
        }}</span>
        <Loader2 class="tw:size-6 tw:animate-spin" />
      </div>
    </div>
    <div :hidden="isFetching" class="tw:flex tw:min-h-0 tw:flex-1 tw:flex-col">
      <div class="tw:shrink-0 tw:px-4">
        <p class="tw:text-xl tw:font-normal">{{ details.name }}</p>
      </div>
      <div class="tw:flex-1 tw:overflow-auto tw:px-4">
        <div class="tw:flex tw:flex-col">
          <div
            v-if="details.startEvents && details.startEvents.length > 0"
            class="tw:mb-2"
          >
            <p class="tw:text-muted-foreground tw:py-1 tw:text-sm">
              {{ $t("processDetailSidebar.startEvents") }}
            </p>
            <div
              v-for="(start, index) in details.startEvents"
              :key="'startEvent-' + index"
              class="tw:py-1"
            >
              <Badge
                class="tw:cursor-pointer"
                @click="goToProcessModel(start.elementId)"
                @mouseenter="
                  model!.highlightPort(ProcessElementType.START_EVENT)
                "
                @mouseleave="
                  model!.unhighlightPort(ProcessElementType.START_EVENT)
                "
                >{{ start.label || "Start" }}
              </Badge>
            </div>
          </div>

          <div
            v-if="details.endEvents && details.endEvents.length > 0"
            class="tw:mb-2"
          >
            <p class="tw:text-muted-foreground tw:py-1 tw:text-sm">
              {{ $t("processDetailSidebar.endEvents") }}
            </p>
            <div
              v-for="(end, index) in details.endEvents"
              :key="'endEvent' + index"
              class="tw:py-1"
            >
              <Badge
                class="tw:cursor-pointer"
                @click="goToProcessModel(end.elementId)"
                @mouseenter="model!.highlightPort(ProcessElementType.END_EVENT)"
                @mouseleave="
                  model!.unhighlightPort(ProcessElementType.END_EVENT)
                "
                >{{ end.label || $t("general.end") }}
              </Badge>
            </div>
          </div>

          <div
            v-if="
              details.intermediateCatchEvents &&
              details.intermediateCatchEvents.length > 0
            "
            class="tw:mb-2"
          >
            <p class="tw:text-muted-foreground tw:py-1 tw:text-sm">
              {{ $t("general.intermediateCatchEvents") }}
            </p>
            <div
              v-for="(event, index) in details.intermediateCatchEvents"
              :key="'endEvent' + index"
              class="tw:py-1"
            >
              <Badge
                class="tw:cursor-pointer"
                @click="goToProcessModel(event.elementId)"
                @mouseenter="
                  model!.highlightPort(
                    ProcessElementType.INTERMEDIATE_CATCH_EVENT
                  )
                "
                @mouseleave="
                  model!.unhighlightPort(
                    ProcessElementType.INTERMEDIATE_CATCH_EVENT
                  )
                "
              >
                {{ event.label || $t("general.intermediateEvent") }}
              </Badge>
            </div>
          </div>

          <div
            v-if="
              details.intermediateThrowEvents &&
              details.intermediateThrowEvents.length > 0
            "
            class="tw:mb-2"
          >
            <p class="tw:text-muted-foreground tw:py-1 tw:text-sm">
              {{ $t("general.intermediateThrowEvents") }}
            </p>
            <div
              v-for="(event, index) in details.intermediateThrowEvents"
              :key="'intermediateThrowEvent' + index"
              class="tw:py-1"
            >
              <Badge
                class="tw:cursor-pointer"
                @click="goToProcessModel(event.elementId)"
                @mouseenter="
                  model!.highlightPort(
                    ProcessElementType.INTERMEDIATE_THROW_EVENT
                  )
                "
                @mouseleave="
                  model!.unhighlightPort(
                    ProcessElementType.INTERMEDIATE_THROW_EVENT
                  )
                "
              >
                {{ event.label || $t("general.intermediateEvent") }}
              </Badge>
            </div>
          </div>

          <div
            v-if="details.activities && details.activities.length > 0"
            class="tw:mb-2"
          >
            <p class="tw:text-muted-foreground tw:py-1 tw:text-sm">
              {{ $t("general.callActivities") }}
            </p>
            <div
              v-for="(activity, index) in details.activities"
              :key="'activity' + index"
              class="tw:py-1"
            >
              <Badge
                class="tw:cursor-pointer"
                @click="goToProcessModel(activity.elementId)"
                @mouseenter="
                  model!.highlightPort(ProcessElementType.CALL_ACTIVITY)
                "
                @mouseleave="
                  model!.unhighlightPort(ProcessElementType.CALL_ACTIVITY)
                "
              >
                {{ activity.label || $t("general.activity") }}
              </Badge>
            </div>
          </div>

          <div v-if="details.description" class="tw:mb-4">
            <p class="tw:text-muted-foreground tw:py-1 tw:text-sm">
              {{ $t("general.description") }}
            </p>
            <div class="tw:py-1">
              {{ details.description }}
            </div>
          </div>
        </div>
      </div>
      <div class="tw:mb-4 tw:shrink-0 tw:px-4 tw:text-center">
        <div id="process-model-viewer" class="tw:mb-4"></div>
        <Button variant="ghost" @click="goToProcessModel(null)">
          {{ $t("processDetailSidebar.goToProcessModel") }}
        </Button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { dia } from "@joint/core";
import { ProcessDetails } from "@/types/processModel";
import {
  getProcessModelDetails,
  getProcessModelXml
} from "@/api/processModels";
import BpmnViewer from "bpmn-js/lib/Viewer";
import { Loader2, PanelRightClose } from "@lucide/vue";
import { AbstractProcessShape } from "@/components/ProcessMap/jointjs/AbstractProcessElement";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProcessElementType, RouteObject } from "./types";

export default defineComponent({
  name: "ProcessDetailSidebar",
  components: {
    Badge,
    Button,
    Loader2,
    PanelRightClose
  },
  emits: ["saveGraphState"],
  data: () => ({
    showSidebar: false as boolean,
    details: {} as ProcessDetails,
    model: null as AbstractProcessShape | null,
    isFetching: false as boolean
  }),
  computed: {
    ProcessElementType() {
      return ProcessElementType;
    }
  },

  methods: {
    async open(model: AbstractProcessShape) {
      this.isFetching = true;
      this.showSidebar = true;
      await this.$nextTick();
      this.model = model;
      const modelId = model.id.toString();
      this.resetProcessModel();
      await this.fetchProcessModel(modelId);
      getProcessModelDetails(modelId).then((details) => {
        this.details = details;
        this.isFetching = false;
      });
    },
    close() {
      this.showSidebar = false;
    },
    async goToProcessModel(portId: string | null) {
      this.unhighlightPorts();
      this.close();
      this.saveGraphState();
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
      viewer
        .get<{
          zoom(newScale: "fit-viewport", center: "auto"): number;
        }>("canvas")
        .zoom("fit-viewport", "auto");
    },
    resetProcessModel() {
      document.getElementById("process-model-viewer")!.innerHTML = "";
    },
    unhighlightPorts() {
      if (this.model) {
        for (const elementType of Object.values(ProcessElementType)) {
          this.model.unhighlightPort(elementType);
        }
      }
    },
    saveGraphState() {
      this.$emit("saveGraphState");
    }
  }
});
</script>

<style scoped>
#process-model-viewer {
  height: 20vh;
}
</style>
