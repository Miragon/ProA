<template>
  <div class="tw:bg-card tw:relative tw:h-full tw:w-full">
    <div
      v-if="isFetching"
      class="tw:flex tw:h-3/4 tw:w-full tw:items-center tw:justify-center"
    >
      <div class="tw:flex tw:flex-col tw:items-center tw:justify-center">
        <span class="tw:mx-5 tw:mb-2 tw:text-center">{{
          $t("processView.loadingProcessModel")
        }}</span>
        <Loader2 class="tw:size-6 tw:animate-spin" />
      </div>
    </div>
    <div id="process-modelling" class="full-screen"></div>
    <div
      class="tw:absolute tw:right-2 tw:bottom-2 tw:flex tw:flex-row tw:gap-[5px]"
    >
      <Button size="icon-lg" class="tw:shadow-lg" @click="goLeft">
        <ChevronLeft />
      </Button>
      <Button size="icon-lg" class="tw:shadow-lg" @click="goRight">
        <ChevronRight />
      </Button>
      <Button size="icon-lg" class="tw:shadow-lg" @click="goUp">
        <ChevronUp />
      </Button>
      <Button size="icon-lg" class="tw:shadow-lg" @click="goDown">
        <ChevronDown />
      </Button>
      <Button size="icon-lg" class="tw:shadow-lg" @click="zoomIn">
        <ZoomIn />
      </Button>
      <Button size="icon-lg" class="tw:shadow-lg" @click="zoomOut">
        <ZoomOut />
      </Button>
      <Button size="icon-lg" class="tw:shadow-lg" @click="fitToScreen">
        <Fullscreen />
      </Button>
    </div>
    <div class="tw:absolute tw:top-2 tw:left-2">
      <Button @click="goBack">
        <ArrowLeft />
        {{ $t("general.back") }}
      </Button>
    </div>
  </div>
</template>
<script lang="ts">
import { defineComponent } from "vue";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Fullscreen,
  Loader2,
  ZoomIn,
  ZoomOut
} from "@lucide/vue";
import { Button } from "@/components/ui/button";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import ElementRegistry from "diagram-js/lib/core/ElementRegistry";
import { ElementLike } from "diagram-js/lib/model/Types";
import { Canvas } from "bpmn-js/lib/features/context-pad/ContextPadProvider";
import { useAppStore } from "@/store/app";
import { getProcessModelXml } from "@/api/processModels";

export default defineComponent({
  components: {
    ArrowLeft,
    Button,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Fullscreen,
    Loader2,
    ZoomIn,
    ZoomOut
  },
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
