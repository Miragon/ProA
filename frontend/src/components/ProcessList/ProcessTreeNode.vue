<template>
  <div class="tw:select-none">
    <div class="tw:flex tw:items-center tw:gap-2 tw:py-2">
      <Button
        v-if="modelNode.children.length > 0"
        variant="ghost"
        size="icon-sm"
        type="button"
        @click="expanded = !expanded"
      >
        <ChevronDown v-if="expanded" />
        <ChevronRight v-else />
        <span class="tw:sr-only">{{ $t("projectOverview.open") }}</span>
      </Button>

      <div class="tw:flex tw:min-w-0 tw:flex-1 tw:flex-col">
        <div class="tw:flex tw:items-center tw:gap-2">
          <span class="tw:truncate tw:font-medium">
            {{ modelNode.processName }}
          </span>
          <span
            v-if="nodeTypeLabel"
            class="tw:text-muted-foreground tw:text-sm"
          >
            {{ nodeTypeLabel }}
          </span>
        </div>
        <span class="tw:text-muted-foreground tw:truncate tw:text-sm">
          {{ getLocaleDate(modelNode.createdAt) }}
          {{ !!modelNode.description ? "-" : "" }} {{ modelNode.description }}
        </span>
      </div>

      <div class="tw:flex tw:shrink-0 tw:items-center">
        <Button
          variant="ghost"
          size="icon"
          type="button"
          @click.stop="$emit('delete-process', modelNode)"
        >
          <Trash2 />
          <span class="tw:sr-only">{{ $t("projectOverview.delete") }}</span>
        </Button>

        <Button
          v-if="
            modelNode.children.length === 0 &&
            modelNode.processType !== 'PARTICIPANT'
          "
          variant="ghost"
          size="icon"
          type="button"
          @click="$emit('upload-process', modelNode.id)"
        >
          <Upload />
          <span class="tw:sr-only">
            {{ $t("processList.replaceProcessModel") }}
          </span>
        </Button>

        <Button variant="ghost" size="icon" as-child>
          <RouterLink :to="'/ProcessView/' + modelNode.id">
            <Eye />
          </RouterLink>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          type="button"
          @click.stop="$emit('more-info', modelNode.id)"
        >
          <Info />
        </Button>
      </div>
    </div>

    <div
      v-if="modelNode.children.length > 0 && expanded"
      class="tw:flex tw:flex-col tw:pl-8"
    >
      <template
        v-for="(child, index) in modelNode.children"
        :key="'child-' + child.id"
      >
        <ProcessTreeNode
          :model="child"
          @delete-process="$emit('delete-process', child)"
          @upload-process="$emit('upload-process', child.id)"
          @more-info="$emit('more-info', child.id)"
        />
        <Separator v-if="index < modelNode.children.length - 1" />
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import { ProcessModelNode } from "@/types/processModel";
import { useAppStore } from "@/store/app";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  Info,
  Trash2,
  Upload
} from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export default {
  name: "ProcessTreeNode",
  components: {
    Button,
    ChevronDown,
    ChevronRight,
    Eye,
    Info,
    Separator,
    Trash2,
    Upload
  },
  props: {
    model: {
      type: Object,
      required: true
    }
  },
  emits: ["delete-process", "more-info", "upload-process"],
  data() {
    return {
      appStore: useAppStore(),
      modelNode: this.model as ProcessModelNode,
      expanded: false as boolean
    };
  },
  computed: {
    nodeTypeLabel(): string {
      if (this.modelNode.children.length > 0) {
        return this.$t("processList.collaboration");
      }
      if (this.modelNode.processType === "PARTICIPANT") {
        return this.$t("processList.participant");
      }
      return "";
    }
  },
  methods: {
    getLocaleDate(date: string): string {
      const locales =
        this.appStore.getSelectedLanguage() === "de" ? "de-DE" : "en-US";
      return new Date(date).toLocaleString(locales);
    }
  }
};
</script>
