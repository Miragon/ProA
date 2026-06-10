<template>
  <v-card height="100%">
    <div
      v-if="isFetching"
      class="d-flex align-center justify-center w-100 h-75"
    >
      <div class="d-flex flex-column align-center justify-center">
        <span class="mb-2 mx-5 text-center">{{
          $t("processView.loadingProcessModel")
        }}</span>
        <v-progress-circular indeterminate />
      </div>
    </div>
    <div id="process-modelling" class="full-screen"></div>
    <div class="ma-4" style="position: absolute; bottom: 8px; right: 8px">
      <v-fab-transition style="margin-right: 5px">
        <v-btn
          class="mt-auto pointer-events-initial"
          color="primary"
          elevation="8"
          icon="mdi-chevron-left"
          size="large"
          @click="goLeft"
        />
      </v-fab-transition>
      <v-fab-transition style="margin-right: 5px">
        <v-btn
          class="mt-auto pointer-events-initial"
          color="primary"
          elevation="8"
          icon="mdi-chevron-right"
          size="large"
          @click="goRight"
        />
      </v-fab-transition>
      <v-fab-transition style="margin-right: 5px">
        <v-btn
          class="mt-auto pointer-events-initial"
          color="primary"
          elevation="8"
          icon="mdi-chevron-up"
          size="large"
          @click="goUp"
        />
      </v-fab-transition>
      <v-fab-transition style="margin-right: 5px">
        <v-btn
          class="mt-auto pointer-events-initial"
          color="primary"
          elevation="8"
          icon="mdi-chevron-down"
          size="large"
          @click="goDown"
        />
      </v-fab-transition>
      <v-fab-transition style="margin-right: 5px">
        <v-btn
          class="mt-auto pointer-events-initial"
          color="primary"
          elevation="8"
          icon="mdi-magnify-plus"
          size="large"
          @click="zoomIn"
        />
      </v-fab-transition>
      <v-fab-transition style="margin-right: 5px">
        <v-btn
          class="mt-auto pointer-events-initial"
          color="primary"
          elevation="8"
          icon="mdi-magnify-minus"
          size="large"
          @click="zoomOut"
        />
      </v-fab-transition>
      <v-fab-transition style="margin-right: 5px">
        <v-btn
          class="mt-auto pointer-events-initial"
          color="primary"
          elevation="8"
          icon="mdi-fit-to-screen"
          size="large"
          @click="fitToScreen"
        />
      </v-fab-transition>
    </div>
    <div class="ma-4" style="position: absolute; top: 8px; left: 8px">
      <v-btn prepend-icon="mdi-arrow-left" @click="goBack">
        {{ $t("general.back") }}
      </v-btn>
    </div>
  </v-card>
</template>
<script lang="ts">
import { defineComponent } from "vue";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import ElementRegistry from "diagram-js/lib/core/ElementRegistry";
import { ElementLike } from "diagram-js/lib/model/Types";
import { Canvas } from "bpmn-js/lib/features/context-pad/ContextPadProvider";
import { useAppStore } from "@/store/app";
import { getProcessModelXml } from "@/api/processModels";

export default defineComponent({
  data: () => ({
    canvas: null as Canvas | null,
    store: useAppStore(),
    scrollStep: 20,
    zoomInMultiplier: 1.1,
    zoomOutMultiplier: 0.9,
    isFetching: false as boolean
  }),

  computed: {
    isUserLoggedIn() {
      return this.store.getUserToken() != null;
    }
  },

  watch: {
    isUserLoggedIn(newValue) {
      if (!newValue) {
        this.$router.push("/");
      }
    }
  },

  async mounted() {
    this.isFetching = true;
    this.addKeydownListener();

    const container = document.querySelector(
      "#process-modelling"
    ) as HTMLElement;
    const viewer = new NavigatedViewer({
      container
    });

    this.canvas = viewer.get("canvas") as Canvas;

    try {
      const xmlText = await getProcessModelXml(this.$route.params.id as string);
      await viewer.importXML(xmlText);
    } catch (error) {
      console.log(error);
    }

    this.canvas.zoom("fit-viewport", "auto");
    const portId = this.$route.query.portId as string;
    if (portId) {
      const elementRegistry = viewer.get<ElementRegistry>("elementRegistry");
      const port = elementRegistry.get(portId);
      if (port) {
        this.translateToCenter(port);
      }
      this.removeQueryParams();
    }

    this.isFetching = false;
  },

  beforeUnmount() {
    this.removeKeydownListener();
  },

  methods: {
    translateToCenter(port: ElementLike) {
      const viewbox = this.canvas.viewbox();
      const elementBounds =
        port.width && port.height ? port : this.canvas.getBBox(port);
      const elementCenter = {
        x: elementBounds.x + elementBounds.width / 2,
        y: elementBounds.y + elementBounds.height / 2
      };
      const newViewbox = {
        x: elementCenter.x - viewbox.width / 2,
        y: elementCenter.y - viewbox.height / 2,
        width: viewbox.width,
        height: viewbox.height
      };
      this.canvas.viewbox(newViewbox);
    },
    zoomIn() {
      const currScale = this.canvas.viewbox().scale;
      this.canvas.zoom(currScale * this.zoomInMultiplier, "auto");
    },
    zoomOut() {
      const currScale = this.canvas.viewbox().scale;
      this.canvas.zoom(currScale * this.zoomOutMultiplier, "auto");
    },
    fitToScreen() {
      this.canvas.zoom("fit-viewport", "auto");
    },
    goRight() {
      const { x, y, width, height } = this.canvas.viewbox();
      this.canvas.viewbox({ x: x - this.scrollStep, y, width, height });
    },
    goLeft() {
      const { x, y, width, height } = this.canvas.viewbox();
      this.canvas.viewbox({ x: x + this.scrollStep, y, width, height });
    },
    goUp() {
      const { x, y, width, height } = this.canvas.viewbox();
      this.canvas.viewbox({ x, y: y + this.scrollStep, width, height });
    },
    goDown() {
      const { x, y, width, height } = this.canvas.viewbox();
      this.canvas.viewbox({ x, y: y - this.scrollStep, width, height });
    },
    removeQueryParams() {
      const url = new URL(window.location.href);
      url.searchParams.delete("portId");
      window.history.replaceState({}, "", url.pathname + url.search);
    },
    goBack() {
      this.removeQueryParams();
      this.$router.go(-1);
    },
    addKeydownListener() {
      window.addEventListener("keydown", this.onKeyDown);
    },
    removeKeydownListener() {
      window.removeEventListener("keydown", this.onKeyDown);
    },
    onKeyDown(evt: KeyboardEvent) {
      switch (evt.key) {
        case "ArrowLeft":
          this.goLeft();
          break;
        case "ArrowRight":
          this.goRight();
          break;
        case "ArrowUp":
          this.goUp();
          break;
        case "ArrowDown":
          this.goDown();
          break;
        case "+":
          this.zoomIn();
          break;
        case "-":
          this.zoomOut();
          break;
        case "f":
          this.fitToScreen();
          break;
      }
    }
  }
});
</script>
<style>
.full-screen {
  width: 100%;
  height: 100%;
}
</style>
