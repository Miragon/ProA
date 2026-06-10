<template>
  <ProcessMapToolbar
    ref="toolbar"
    :selected-project-id="selectedProjectId"
    :selected-project-name="selectedProjectName"
    :selected-version-name="selectedVersionName"
    :selected-version-id="selectedVersionId!"
    @fetch-process-models="fetchProcessModels"
    @filter-graph="filterGraph"
    @handle-fetch-process-instances="handleFetchProcessInstances"
  />
  <v-card class="full-screen-below-toolbar" @mouseup="saveGraphState">
    <ProcessDetailSidebar
      ref="processDetailSidebar"
      @save-graph-state="saveGraphState"
    />
    <div
      v-if="isFetching"
      class="d-flex align-center justify-center w-100 h-75"
    >
      <div class="d-flex flex-column align-center justify-center">
        <span class="mb-2">{{ $t("processMap.loadingProcessMap") }}</span>
        <v-progress-circular indeterminate />
      </div>
    </div>
    <div id="graph-container" :hidden="isFetching" class="full-screen"></div>
    <NavigationButtons
      ref="navigationButtons"
      :selected-project-id="selectedProjectId"
    />
  </v-card>
  <v-tooltip
    id="tool-tip"
    v-model="tooltipVisible"
    :style="{ position: 'fixed', top: mouseY, left: mouseX }"
  >
    <ul v-if="tooltipList.length > 0">
      <li v-for="item in tooltipList" :key="item">{{ item }}</li>
    </ul>
    <span v-if="tooltipList.length === 0">{{
      $t("processMap.noInformationAvailable")
    }}</span>
  </v-tooltip>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { dia, shapes } from "@joint/core";
import { DirectedGraph } from "@joint/layout-directed-graph";

import { graph, paper } from "./jointjs/JointJSDiagram";
import createAbstractProcessElement, {
  AbstractProcessShape
} from "./jointjs/AbstractProcessElement";
import createAbstractDataStoreElement, {
  AbstractDataStoreShape
} from "./jointjs/AbstractDataStoreElement";
import { PortTargetArrowhead } from "./jointjs/PortTargetArrowHead";
import createLinkRemoveButton from "@/components/ProcessMap/jointjs/createLinkRemoveButton";
import {
  Connection,
  DataStore,
  FilterGraphInput,
  HiddenLinks,
  HiddenPorts,
  MessageFlow,
  PortsInformation,
  Process,
  ProcessElementType
} from "./types";

import ProcessDetailSidebar from "@/components/ProcessMap/ProcessDetailSidebar.vue";
import ProcessMapToolbar from "@/components/ProcessMap/ProcessMapToolbar.vue";
import NavigationButtons from "@/components/ProcessMap/NavigationButtons.vue";
import { getProject } from "@/api/projects";
import * as processMapApi from "@/api/processMap";
import * as camundaCloudApi from "@/api/camundaCloud";
import { getSettings } from "@/api/settings";
import { useAppStore } from "@/store/app";
import { Settings } from "@/types/settings";

export const getPortPrefix = (elementType: ProcessElementType): string => {
  switch (elementType) {
    case ProcessElementType.START_EVENT:
      return "start-";
    case ProcessElementType.INTERMEDIATE_CATCH_EVENT:
      return "i-catch-event-";
    case ProcessElementType.INTERMEDIATE_THROW_EVENT:
      return "i-throw-event-";
    case ProcessElementType.END_EVENT:
      return "end-";
    case ProcessElementType.CALL_ACTIVITY:
      return "call-";
    default:
      return "";
  }
};

export default defineComponent({
  components: {
    NavigationButtons,
    ProcessDetailSidebar,
    ProcessMapToolbar
  },

  data() {
    const appStore = useAppStore();
    const selectedProjectId: number = appStore.getSelectedProjectId()!;
    // All view state (graph, paper layout, filters, hidden cells/ports/links)
    // is persisted per project *version*, since the process map contents are
    // version specific.
    const activeVersionId =
      appStore.getActiveVersionForProject(selectedProjectId)?.id;
    const persistedHiddenCells =
      activeVersionId != null
        ? appStore.getHiddenCellsForProject(activeVersionId)
        : undefined;
    const persistedHiddenLinks =
      activeVersionId != null
        ? appStore.getHiddenLinksForProject(activeVersionId)
        : undefined;
    const persistedHiddenPorts =
      activeVersionId != null
        ? appStore.getHiddenPortsForProject(activeVersionId)
        : undefined;

    const hiddenCells: dia.Cell[] = persistedHiddenCells
      ? JSON.parse(persistedHiddenCells!)
      : [];
    const hiddenLinks: HiddenLinks = persistedHiddenLinks ?? {};
    const hiddenPorts: HiddenPorts = persistedHiddenPorts
      ? JSON.parse(persistedHiddenPorts)
      : {};
    const portsInformation: PortsInformation = {};

    return {
      mouseX: "" as string,
      mouseY: "" as string,
      operateToken: "" as string,
      tooltipList: [] as string[],
      tooltipVisible: false as boolean,
      settings: {} as Settings,
      appStore,
      hiddenCells,
      hiddenLinks,
      hiddenPorts,
      portsInformation,
      selectedProjectId,
      selectedProjectName: "" as string,
      selectedVersionName: "" as string,
      selectedVersionId: null as number | null,
      isFetching: false as boolean
    };
  },

  computed: {
    toolbar() {
      return this.$refs.toolbar as InstanceType<typeof ProcessMapToolbar>;
    },
    navigationButtons() {
      return this.$refs.navigationButtons as InstanceType<
        typeof NavigationButtons
      >;
    },
    isUserLoggedIn() {
      return this.appStore.getUserToken() !== null;
    }
  },

  watch: {
    isUserLoggedIn(newValue) {
      if (!newValue) {
        this.$router.push("/");
      }
    }
  },

  mounted() {
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
      this.initProcessMap();
    });
  },
  methods: {
    initProcessMap() {
      const store = useAppStore();
      const paperContainer = document.getElementById("graph-container");
      paperContainer!.appendChild(paper.el);

      const processDetailSidebar = this.$refs
        .processDetailSidebar as InstanceType<typeof ProcessDetailSidebar>;

      paper.on("cell:pointerdblclick", function (cellView) {
        const model = cellView.model;
        if (model instanceof AbstractProcessShape) {
          processDetailSidebar.open(model as AbstractProcessShape);
        }
      });

      paper.on("element:mouseover", (view, evt) => {
        const port = view.findAttribute("port", evt.target);
        if (port) {
          this.tooltipList = this.portsInformation[port];
          this.tooltipVisible = true;

          this.mouseX = evt.clientX! + "px !important";
          this.mouseY = evt.clientY! + "px !important";
        }
      });

      paper.on("element:mouseout", (view, evt) => {
        const port = view.findAttribute("port", evt.target);
        if (port) {
          this.tooltipVisible = false;
        }
      });

      if (store.getProcessModelsChangeFlag()) {
        this.fetchProcessModels();
        store.unsetProcessModelsChanged();
        return;
      }

      const persistedGraph = this.appStore.getGraphForProject(
        this.selectedVersionId!
      );
      if (persistedGraph) {
        Object.assign(
          this.portsInformation,
          this.appStore.getPortsInformationByProject(this.selectedVersionId!)
        );
        graph.fromJSON(JSON.parse(persistedGraph));
      } else {
        this.fetchProcessModels();
        return;
      }
      const persistedLayout = this.appStore.getPaperLayoutForProject(
        this.selectedVersionId!
      );
      if (persistedLayout) {
        const { sx, tx, ty } = JSON.parse(persistedLayout);
        paper.scale(sx);
        paper.translate(tx, ty);
      }

      const clearTools = () => {
        if (!lastView) return;
        lastView.removeTools();
      };
      let timer: NodeJS.Timeout;
      let lastView: dia.LinkView;
      paper.on("link:mouseenter", (linkView) => {
        if (linkView.model.get("source").id.toString().startsWith("ds")) {
          return;
        }
        if (linkView.model.get("isMessageFlow")) {
          return;
        }
        clearTimeout(timer);
        clearTools();
        lastView = linkView;
        linkView.addTools(
          new dia.ToolsView({
            name: "onhover",
            tools: [
              new PortTargetArrowhead(),
              createLinkRemoveButton(removeLink)
            ]
          })
        );
      });

      paper.on("link:mouseleave", () => {
        timer = setTimeout(() => clearTools(), 500);
      });

      paper.on("link:connect", async (linkView) => {
        const link = linkView.model;
        const callingProcessid = link.source().id;
        const calledProcessid = link.target().id;
        const callingElementType = this.getProcessElementType(
          link.source().port || ""
        );
        const calledElementType = this.getProcessElementType(
          link.target().port || ""
        );

        try {
          await processMapApi.createConnection(this.selectedVersionId!, {
            callingProcessid,
            calledProcessid,
            callingElementType,
            calledElementType,
            userCreated: true
          });
        } catch (error) {
          console.error("Error while adding connection:", error);
        }
      });

      paper.on("link:disconnect", async (linkView, _evt, prevElementView) => {
        const link = linkView.model;
        const connectionId = link?.attributes?.connectionId;
        const callingProcessid = link?.source()?.id?.toString();
        const calledProcessid = prevElementView.model.id.toString();
        if (!callingProcessid || !calledProcessid || !connectionId) {
          console.error("Error while removing connection");
          return;
        }
        await removeLinkHelper(connectionId, callingProcessid, calledProcessid);
      });

      const removeProcessLink = async (
        connectionId: number
      ): Promise<boolean> => {
        try {
          await processMapApi.deleteProcessConnection(connectionId);
          return true;
        } catch (error) {
          console.error("Error while removing process connection:", error);
          return false;
        }
      };

      const removeDataStoreLink = async (
        connectionId: number
      ): Promise<boolean> => {
        try {
          await processMapApi.deleteDataStoreConnection(connectionId);
          return true;
        } catch (error) {
          console.error("Error while removing datastore connection:", error);
          return false;
        }
      };

      const removeLink = async (
        _evt: dia.Event,
        linkView: dia.LinkView,
        toolView: dia.ToolView
      ): Promise<void> => {
        const link = linkView.model;
        const connectionId = link?.attributes?.connectionId;
        const callingProcessid = link?.source()?.id?.toString();
        const calledProcessid = link?.target()?.id?.toString();
        if (!callingProcessid || !calledProcessid || !connectionId) {
          console.error("Error while removing connection");
          return;
        }
        const wasLinkRemoved = await removeLinkHelper(
          connectionId,
          callingProcessid,
          calledProcessid
        );
        if (!wasLinkRemoved) {
          return;
        }
        linkView.model.remove({ ui: true, tool: toolView.cid });
      };

      const removeLinkHelper = async (
        connectionId: number,
        callingProcessid: string,
        calledProcessid: string
      ): Promise<boolean> => {
        if (
          callingProcessid.startsWith("ds") ||
          calledProcessid.startsWith("ds")
        ) {
          return await removeDataStoreLink(connectionId);
        }

        return await removeProcessLink(connectionId);
      };
    },
    saveGraphState() {
      setTimeout(() => {
        this.appStore.setGraphForProject(
          this.selectedVersionId!,
          JSON.stringify(graph)
        );
      }, 50);
    },
    saveFilters() {
      this.toolbar.saveFilters();
    },
    saveHiddenElements() {
      this.appStore.setHiddenCellsForProject(
        this.selectedVersionId!,
        JSON.stringify(this.hiddenCells)
      );
      this.appStore.setHiddenLinksForProject(
        this.selectedVersionId!,
        this.hiddenLinks
      );
    },
    saveHiddenPorts() {
      this.appStore.setHiddenPortsForProject(
        this.selectedVersionId!,
        JSON.stringify(this.hiddenPorts)
      );
    },
    resetFilters() {
      this.toolbar.clearFilters();
      this.hiddenCells = [];
      this.hiddenPorts = {};
      this.saveFilters();
      this.saveHiddenElements();
      this.saveHiddenPorts();
    },
    fetchProcessModels() {
      this.isFetching = true;
      this.resetFilters();
      graph.clear();
      processMapApi
        .getProcessMap(this.selectedVersionId!)
        .then((processMap) => {
          const abstractProcessShapes: AbstractProcessShape[] =
            processMap.processes.map((process: Process) => {
              const filterEmpty = (label: string) => !!label;

              this.portsInformation["start-" + process.id] = process.startEvents
                .filter((event) => filterEmpty(event.label))
                .map((e) => e.label);
              this.portsInformation["i-catch-event-" + process.id] =
                process.intermediateCatchEvents
                  .filter((event) => filterEmpty(event.label))
                  .map((e) => e.label);
              this.portsInformation["i-throw-event-" + process.id] =
                process.intermediateThrowEvents
                  .filter((event) => filterEmpty(event.label))
                  .map((e) => e.label);
              this.portsInformation["end-" + process.id] = process.endEvents
                .filter((event) => filterEmpty(event.label))
                .map((e) => e.label);
              this.portsInformation["call-" + process.id] = process.activities
                .filter((event) => filterEmpty(event.label))
                .map((e) => e.label);

              return createAbstractProcessElement(
                process.name,
                process.id,
                process.bpmnProcessId
              );
            });

          this.appStore.setPortsInformationByProject(
            this.selectedVersionId!,
            this.portsInformation
          );

          graph.addCell(abstractProcessShapes);

          const connectionsShapes = processMap.connections.map(
            (connection: Connection) => {
              const link = new shapes.standard.Link();

              const callingPortPrefix = getPortPrefix(
                connection.callingElementType
              );
              const calledPortPrefix = getPortPrefix(
                connection.calledElementType
              );

              link.set({
                connectionId: connection.id,
                source: {
                  id: connection.callingProcessid,
                  port: callingPortPrefix + connection.callingProcessid
                },
                target: {
                  id: connection.calledProcessid,
                  port: calledPortPrefix + connection.calledProcessid
                }
              });

              if (connection.label) {
                link.appendLabel({
                  attrs: {
                    text: {
                      text: connection.label
                    }
                  }
                });
              }

              return link;
            }
          );

          graph.addCell(connectionsShapes);

          const messageFlowShapes = processMap.messageFlows.map(
            (messageFlow: MessageFlow) => {
              const link = new shapes.standard.Link();

              const callingPortPrefix = getPortPrefix(
                messageFlow.callingElementType
              );
              const calledPortPrefix = getPortPrefix(
                messageFlow.calledElementType
              );

              link.set({
                connectionId: messageFlow.bpmnId,
                source: {
                  id: messageFlow.callingProcessId,
                  port: callingPortPrefix + messageFlow.callingProcessId
                },
                target: {
                  id: messageFlow.calledProcessId,
                  port: calledPortPrefix + messageFlow.calledProcessId
                },
                isMessageFlow: true
              });

              link.attr({
                line: {
                  strokeDasharray: "5,5"
                }
              });

              if (messageFlow.name) {
                link.appendLabel({
                  attrs: {
                    text: {
                      text: messageFlow.name
                    }
                  }
                });
              }

              return link;
            }
          );

          graph.addCell(messageFlowShapes);

          const abstractDataStores = processMap.dataStores.map(
            (dataStore: DataStore) => {
              return createAbstractDataStoreElement(
                dataStore.name,
                dataStore.id
              );
            }
          );

          graph.addCell(abstractDataStores);

          const dataStoreConnectionShapes = processMap.dataStoreConnections.map(
            (connection) => {
              const link = new shapes.standard.Link();
              const source = {
                id: connection.processid,
                port: "call-" + connection.processid
              };
              const target = {
                id: "ds-" + connection.dataStoreId,
                anchor: { name: "midSide", args: { rotate: true } }
              };

              if (connection.access === "READ_WRITE") {
                link.attr({
                  line: {
                    sourceMarker: {
                      type: "path",
                      stroke: "black",
                      fill: "black",
                      d: "M 10 -5 0 0 10 5 Z"
                    },
                    targetMarker: {
                      type: "path",
                      stroke: "black"
                    }
                  }
                });

                link.set({ connectionId: connection.id, source, target });
              } else if (connection.access === "WRITE") {
                link.set({ connectionId: connection.id, source, target });
              } else if (connection.access === "READ") {
                link.set({
                  connectionId: connection.id,
                  source: target,
                  target: source
                });
              }

              return link;
            }
          );

          graph.addCell(dataStoreConnectionShapes);

          DirectedGraph.layout(graph, {
            nodeSep: 80,
            edgeSep: 100,
            rankSep: 80,
            rankDir: "LR"
          });

          setTimeout(this.fitToScreen, 1);

          this.saveGraphState();
          this.isFetching = false;
        });
    },
    getProcessElementType(portId: string): ProcessElementType | null {
      const mappings: { [key: string]: ProcessElementType } = {
        "start-": ProcessElementType.START_EVENT,
        "i-catch-event-": ProcessElementType.INTERMEDIATE_CATCH_EVENT,
        "i-throw-event-": ProcessElementType.INTERMEDIATE_THROW_EVENT,
        "end-": ProcessElementType.END_EVENT,
        "call-": ProcessElementType.CALL_ACTIVITY
      };

      for (const prefix in mappings) {
        if (portId.startsWith(prefix)) {
          return mappings[prefix];
        }
      }

      return null;
    },
    filterGraph({
      hideAbstractDataStores,
      hideCallActivities,
      hideIntermediateEvents,
      hideStartEndEvents,
      hideProcessesWithoutConnections,
      hideConnectionLabels,
      hideMessageFlows
    }: FilterGraphInput) {
      if (!hideConnectionLabels) {
        for (const link of graph.getLinks()) {
          const label = this.hiddenLinks[link.id];
          if (label) {
            link.appendLabel({
              attrs: {
                text: {
                  text: label
                }
              }
            });
          }
        }
      }

      graph.addCells(
        this.hiddenCells.map((cell) =>
          cell?.attributes ? cell.attributes : cell
        ) as dia.Cell[]
      );
      this.hiddenCells = [];
      for (const [cellId, ports] of Object.entries(this.hiddenPorts)) {
        const cell = graph.getCell(cellId);
        if (cell instanceof AbstractProcessShape) {
          cell.addPorts(ports);
        }
      }
      this.hiddenPorts = {};

      const cellsToHide: dia.Cell[] = [];

      for (const link of graph.getLinks()) {
        const sourceCell = link.getSourceCell();
        const targetCell = link.getTargetCell();
        const sourcePort = link?.attributes?.source?.port;
        const targetPort = link?.attributes?.target?.port;

        if (
          hideAbstractDataStores &&
          (sourceCell instanceof AbstractDataStoreShape ||
            targetCell instanceof AbstractDataStoreShape)
        ) {
          cellsToHide.push(link);

          if (
            sourceCell instanceof AbstractDataStoreShape &&
            !cellsToHide.includes(sourceCell)
          ) {
            cellsToHide.push(sourceCell);
          }
          if (
            targetCell instanceof AbstractDataStoreShape &&
            !cellsToHide.includes(targetCell)
          ) {
            cellsToHide.push(targetCell);
          }
        } else if (
          hideCallActivities &&
          (sourcePort?.startsWith("call") || targetPort?.startsWith("call"))
        ) {
          cellsToHide.push(link);
        } else if (
          hideIntermediateEvents &&
          (sourcePort?.startsWith("i-") || targetPort?.startsWith("i-"))
        ) {
          cellsToHide.push(link);
        } else if (
          hideStartEndEvents &&
          sourcePort?.startsWith("end") &&
          targetPort?.startsWith("start")
        ) {
          cellsToHide.push(link);
        } else if (hideMessageFlows && link.get("isMessageFlow")) {
          cellsToHide.push(link);
        }
      }

      this.hiddenCells = cellsToHide;
      graph.removeCells(cellsToHide);

      const processesWithoutConnections: dia.Cell[] = [];
      for (const cell of graph.getCells()) {
        if (
          hideProcessesWithoutConnections &&
          (cell instanceof AbstractProcessShape ||
            cell instanceof AbstractDataStoreShape) &&
          graph.getConnectedLinks(cell).length === 0
        ) {
          processesWithoutConnections.push(cell);
        } else if (cell instanceof AbstractProcessShape) {
          if (hideCallActivities) {
            const portId = "call-" + cell.id;
            this.hiddenPorts[cell.id] = this.hiddenPorts[cell.id] || [];
            this.hiddenPorts[cell.id].push(cell.getPort(portId));
            cell.removePort(portId);
          }
          if (hideIntermediateEvents) {
            const portIds = [
              "i-catch-event-" + cell.id,
              "i-throw-event-" + cell.id
            ];
            this.hiddenPorts[cell.id] = this.hiddenPorts[cell.id] || [];
            this.hiddenPorts[cell.id].push(cell.getPort(portIds[0]));
            this.hiddenPorts[cell.id].push(cell.getPort(portIds[1]));
            cell.removePorts(portIds);
          }
        }
      }

      this.hiddenCells.push(...processesWithoutConnections);
      graph.removeCells(processesWithoutConnections);

      if (hideConnectionLabels) {
        for (const link of graph.getLinks()) {
          const labelText = link.labels()[0]?.attrs!.text!.text;
          if (labelText) {
            this.hiddenLinks[link.id] = labelText;
          }
          link.removeLabel();
        }
      }

      this.saveGraphState();
      this.saveFilters();
      this.saveHiddenElements();
      this.saveHiddenPorts();
    },
    async fetchSettings() {
      try {
        this.settings = (await getSettings()) ?? ({} as Settings);
      } catch {
        this.settings = {} as Settings;
      }

      this.settings.geminiApiKey =
        this.settings.geminiApiKey || import.meta.env.VITE_GEMINI_API_KEY;
      this.settings.modelerClientId =
        this.settings.modelerClientId || import.meta.env.VITE_MODELER_CLIENT_ID;
      this.settings.modelerClientSecret =
        this.settings.modelerClientSecret ||
        import.meta.env.VITE_MODELER_CLIENT_SECRET;
      this.settings.operateClientId =
        this.settings.operateClientId || import.meta.env.VITE_OPERATE_CLIENT_ID;
      this.settings.operateClientSecret =
        this.settings.operateClientSecret ||
        import.meta.env.VITE_OPERATE_CLIENT_SECRET;
      this.settings.operateRegionId =
        this.settings.operateRegionId || import.meta.env.VITE_OPERATE_REGION_ID;
      this.settings.operateClusterId =
        this.settings.operateClusterId ||
        import.meta.env.VITE_OPERATE_CLUSTER_ID;
    },
    async handleFetchProcessInstances() {
      await this.fetchSettings();
      if (
        !this.settings.operateClientId ||
        !this.settings.operateClientSecret
      ) {
        this.appStore.setOperateConnectionError(
          this.$t("processMap.operateConnectionMissing")
        );
        this.appStore.setAreSettingsOpened(true);
        return;
      }
      if (!this.settings.operateRegionId || !this.settings.operateClusterId) {
        this.appStore.setOperateClusterError(
          this.$t("processMap.operateClusterMissing")
        );
        this.appStore.setAreSettingsOpened(true);
        return;
      }
      try {
        this.operateToken = await camundaCloudApi.fetchToken(
          this.settings.operateClientId,
          this.settings.operateClientSecret,
          "operate.camunda.io"
        );
        await this.fetchProcessInstances();
      } catch {
        this.appStore.setAreSettingsOpened(true);
        return;
      }
    },
    async fetchProcessInstances() {
      const promises = graph
        .getCells()
        .filter((cell) => cell instanceof AbstractProcessShape)
        .map((cell) => {
          return camundaCloudApi.fetchProcessInstances({
            token: this.operateToken,
            regionId: this.settings.operateRegionId,
            clusterId: this.settings.operateClusterId,
            bpmnProcessId: cell.attributes.bpmnProcessId
          });
        });

      const results = await Promise.all(promises);
      const items = results.flat();

      const countByProcess = items
        .filter((item) => item.state === "ACTIVE")
        .reduce((countByProcess: Map<string, number>, item) => {
          countByProcess.set(
            item.bpmnProcessId,
            (countByProcess.get(item.bpmnProcessId) ?? 0) + 1
          );
          return countByProcess;
        }, new Map<string, number>());
      for (const cell of graph.getCells()) {
        if (cell instanceof AbstractProcessShape) {
          const countForBpmnProcessId = countByProcess.get(
            cell.attributes.bpmnProcessId
          );
          if (countForBpmnProcessId) {
            cell.setActiveInstances(countForBpmnProcessId);
          } else {
            cell.hideActiveInstances();
          }
        }
      }
    },
    fitToScreen() {
      this.navigationButtons.fitToScreen();
    }
  }
});
</script>

<style>
.full-screen-below-toolbar {
  width: 100%;
  height: calc(100% - 64px) !important;
}

.full-screen {
  width: 100%;
  height: 100%;
}
</style>
