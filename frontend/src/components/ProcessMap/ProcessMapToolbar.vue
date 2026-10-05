<template>
  <div
    class="tw:bg-background tw:flex tw:h-16 tw:items-center tw:gap-2 tw:border-b tw:px-4"
  >
    <div class="tw:flex tw:items-center">
      <span class="tw:text-lg">{{ selectedProjectName }}</span>
      <span class="tw:text-muted-foreground tw:ml-4 tw:text-sm"
        >VERSION {{ selectedVersionName }}</span
      >
    </div>

    <div class="tw:flex-1"></div>

    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            @click="handleFetchProcessInstances"
          >
            <Play />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {{ $t("processMap.retrieveProcessInstances") }}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>

    <Popover>
      <PopoverTrigger as-child>
        <Button variant="ghost" size="icon" class="tw:mr-[5px]">
          <Map />
        </Button>
      </PopoverTrigger>
      <PopoverContent class="tw:w-auto tw:p-0">
        <ProcessMapLegend />
      </PopoverContent>
    </Popover>

    <Popover>
      <PopoverTrigger as-child>
        <Button variant="ghost" size="icon" class="tw:relative tw:mr-[5px]">
          <Filter />
          <Badge
            v-if="filtersCount > 0"
            class="tw:absolute tw:-top-1 tw:-right-1 tw:size-4 tw:p-0"
          >
            {{ filtersCount }}
          </Badge>
        </Button>
      </PopoverTrigger>
      <PopoverContent class="tw:w-auto tw:p-1">
        <div
          class="tw:flex tw:items-center tw:justify-between tw:px-2 tw:py-1.5 tw:font-bold"
        >
          <div>{{ $t("processMap.hide") }}:</div>
          <Button
            variant="ghost"
            size="sm"
            class="tw:text-muted-foreground"
            @click="clearFilters"
          >
            {{ $t("processMap.clear") }}
          </Button>
        </div>
        <Separator class="tw:my-1" />
        <div
          v-for="(label, filterOption) in filterOptions"
          :key="filterOption"
          class="tw:flex tw:items-center tw:gap-2 tw:px-2 tw:py-1.5"
        >
          <Checkbox
            :id="'filter-' + filterOption"
            :model-value="filterGraphInput[filterOption]"
            @update:model-value="onFilterChange(filterOption, $event)"
          />
          <Label :for="'filter-' + filterOption" class="tw:font-normal">
            {{ label }}
          </Label>
        </div>
      </PopoverContent>
    </Popover>

    <Button variant="ghost" size="icon" @click="fetchProcessModels">
      <RefreshCw />
    </Button>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { Filter, Map, Play, RefreshCw } from "@lucide/vue";

import ProcessMapLegend from "@/components/ProcessMap/ProcessMapLegend.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";
import { useAppStore } from "@/store/app";

type FilterOption = keyof ProcessMapToolbarData["filterGraphInput"];

interface ProcessMapToolbarData {
  filterGraphInput: {
    hideAbstractDataStores: boolean;
    hideCallActivities: boolean;
    hideConnectionLabels: boolean;
    hideIntermediateEvents: boolean;
    hideProcessesWithoutConnections: boolean;
    hideStartEndEvents: boolean;
    hideMessageFlows: boolean;
  };
}

export default defineComponent({
  name: "ProcessMapToolbar",
  components: {
    ProcessMapLegend,
    Badge,
    Button,
    Checkbox,
    Filter,
    Label,
    Map,
    Play,
    Popover,
    PopoverContent,
    PopoverTrigger,
    RefreshCw,
    Separator,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger
  },

  props: {
    selectedProjectId: {
      type: Number,
      required: true
    },
    selectedProjectName: {
      type: String,
      required: true
    },
    selectedVersionName: {
      type: String,
      required: true
    },
    selectedVersionId: {
      type: Number,
      required: true
    }
  },

  emits: ["filterGraph", "fetchProcessModels", "handleFetchProcessInstances"],

  data() {
    const store = useAppStore();
    // Filters are persisted per project *version* (same key as the graph
    // state in ProcessMap.vue). The version id is derived from the store
    // because the selectedVersionId prop is not set yet when data() runs.
    const activeVersionId = store.getActiveVersionForProject(
      this.selectedProjectId
    )?.id;
    const persistedFilterGraphInput =
      activeVersionId != null
        ? store.getFiltersForProject(activeVersionId)
        : undefined;

    const defaultFilterGraphInput = {
      hideAbstractDataStores: false,
      hideCallActivities: false,
      hideConnectionLabels: false,
      hideIntermediateEvents: false,
      hideProcessesWithoutConnections: false,
      hideStartEndEvents: false,
      hideMessageFlows: false
    };

    let filterGraphInput = { ...defaultFilterGraphInput };

    if (persistedFilterGraphInput) {
      filterGraphInput = JSON.parse(persistedFilterGraphInput);
    }

    return {
      defaultFilterGraphInput,
      filterGraphInput,
      store
    };
  },

  computed: {
    filterOptions() {
      return {
        hideAbstractDataStores: this.$t("processMap.resources"),
        hideCallActivities: this.$t("general.callActivities"),
        hideConnectionLabels: this.$t("processMap.connectionLabels"),
        hideIntermediateEvents: this.$t("processMap.intermediateEvents"),
        hideProcessesWithoutConnections: this.$t(
          "processMap.processesWithoutConnections"
        ),
        hideStartEndEvents: this.$t("processMap.endToStartConnections"),
        hideMessageFlows: this.$t("processMap.messageFlows")
      };
    },
    filtersCount(): number {
      return Object.values(this.filterGraphInput).filter((value) => value)
        .length;
    }
  },

  mounted() {},

  methods: {
    clearFilters() {
      this.filterGraphInput = { ...this.defaultFilterGraphInput };
      this.$emit("filterGraph", this.filterGraphInput);
    },
    fetchProcessModels() {
      this.$emit("fetchProcessModels");
    },
    filterGraph() {
      this.$emit("filterGraph", this.filterGraphInput);
    },
    onFilterChange(
      filterOption: FilterOption,
      value: boolean | "indeterminate"
    ) {
      this.filterGraphInput[filterOption] = value === true;
      this.filterGraph();
    },
    handleFetchProcessInstances() {
      this.$emit("handleFetchProcessInstances");
    },
    saveFilters() {
      const activeVersionId = this.store.getActiveVersionForProject(
        this.selectedProjectId
      )?.id;
      if (activeVersionId == null) {
        return;
      }
      this.store.setFiltersForProject(
        activeVersionId,
        JSON.stringify(this.filterGraphInput)
      );
    }
  }
});
</script>

<style scoped></style>
