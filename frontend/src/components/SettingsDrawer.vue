<template>
  <Sheet
    :open="appStore.areSettingsOpened"
    @update:open="appStore.setAreSettingsOpened($event)"
  >
    <SheetContent side="right" class="tw:w-[400px] tw:sm:max-w-[400px]">
      <SheetHeader>
        <SheetTitle>{{ $t("general.settings") }}</SheetTitle>
        <SheetDescription class="tw:sr-only">
          {{ $t("general.settings") }}
        </SheetDescription>
      </SheetHeader>

      <div class="tw:flex tw:flex-col tw:gap-4 tw:overflow-y-auto tw:px-4">
        <div class="tw:flex tw:flex-col tw:gap-2">
          <p class="tw:text-muted-foreground tw:text-sm tw:font-medium">
            {{ $t("settingsDrawer.camundaModelerConnection") }}
          </p>
          <div class="tw:flex tw:flex-col tw:gap-1.5">
            <Label for="modeler-client-id">{{ $t("general.clientId") }}</Label>
            <Input
              id="modeler-client-id"
              v-model="settings.modelerClientId"
              :aria-invalid="!!modelerError"
              :disabled="isValidating"
              @input="resetMessagesModeler"
            />
          </div>
          <div class="tw:flex tw:flex-col tw:gap-1.5">
            <Label for="modeler-client-secret">
              {{ $t("general.clientSecret") }}
            </Label>
            <div class="tw:relative">
              <Input
                id="modeler-client-secret"
                v-model="settings.modelerClientSecret"
                :type="showModelerClientSecret ? 'text' : 'password'"
                :aria-invalid="!!modelerError"
                :disabled="isValidating"
                class="tw:pr-9"
                @input="resetMessagesModeler"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                class="tw:absolute tw:top-1/2 tw:right-1 tw:-translate-y-1/2"
                @click="showModelerClientSecret = !showModelerClientSecret"
              >
                <Eye v-if="showModelerClientSecret" />
                <EyeOff v-else />
              </Button>
            </div>
            <span v-if="modelerError" class="tw:text-destructive tw:text-sm">
              {{ modelerError }}
            </span>
            <span
              v-else-if="modelerSuccessMsg"
              class="tw:text-muted-foreground tw:text-sm"
            >
              {{ modelerSuccessMsg }}
            </span>
          </div>
        </div>

        <div class="tw:flex tw:flex-col tw:gap-2">
          <p class="tw:text-muted-foreground tw:text-sm tw:font-medium">
            {{ $t("settingsDrawer.camundaOperateConnection") }}
          </p>
          <div class="tw:flex tw:flex-col tw:gap-1.5">
            <Label for="operate-client-id">{{ $t("general.clientId") }}</Label>
            <Input
              id="operate-client-id"
              v-model="settings.operateClientId"
              :aria-invalid="!!appStore.operateConnectionError"
              :disabled="isValidating"
              @input="resetMessagesOperateConnection"
            />
          </div>
          <div class="tw:flex tw:flex-col tw:gap-1.5">
            <Label for="operate-client-secret">
              {{ $t("general.clientSecret") }}
            </Label>
            <div class="tw:relative">
              <Input
                id="operate-client-secret"
                v-model="settings.operateClientSecret"
                :type="showOperateClientSecret ? 'text' : 'password'"
                :aria-invalid="!!appStore.operateConnectionError"
                :disabled="isValidating"
                class="tw:pr-9"
                @input="resetMessagesOperateConnection"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                class="tw:absolute tw:top-1/2 tw:right-1 tw:-translate-y-1/2"
                @click="showOperateClientSecret = !showOperateClientSecret"
              >
                <Eye v-if="showOperateClientSecret" />
                <EyeOff v-else />
              </Button>
            </div>
            <span
              v-if="appStore.operateConnectionError"
              class="tw:text-destructive tw:text-sm"
            >
              {{ appStore.operateConnectionError }}
            </span>
            <span
              v-else-if="operateConnectionSuccessMsg"
              class="tw:text-muted-foreground tw:text-sm"
            >
              {{ operateConnectionSuccessMsg }}
            </span>
          </div>
          <div class="tw:flex tw:flex-col tw:gap-1.5">
            <Label for="operate-region-id">
              {{ $t("settingsDrawer.regionId") }}
            </Label>
            <Input
              id="operate-region-id"
              v-model="settings.operateRegionId"
              :aria-invalid="!!appStore.operateClusterError"
              :disabled="isValidating"
              @input="resetMessagesOperateCluster"
            />
          </div>
          <div class="tw:flex tw:flex-col tw:gap-1.5">
            <Label for="operate-cluster-id">
              {{ $t("settingsDrawer.clusterId") }}
            </Label>
            <Input
              id="operate-cluster-id"
              v-model="settings.operateClusterId"
              :aria-invalid="!!appStore.operateClusterError"
              :disabled="isValidating"
              @input="resetMessagesOperateCluster"
            />
            <span
              v-if="appStore.operateClusterError"
              class="tw:text-destructive tw:text-sm"
            >
              {{ appStore.operateClusterError }}
            </span>
            <span
              v-else-if="operateClusterSuccessMsg"
              class="tw:text-muted-foreground tw:text-sm"
            >
              {{ operateClusterSuccessMsg }}
            </span>
          </div>
        </div>

        <div class="tw:flex tw:items-center tw:gap-3">
          <Button :disabled="isValidating" @click="saveSettings">
            <Loader2 v-if="isValidating" class="tw:animate-spin" />
            {{ $t("general.save") }}
          </Button>
          <TooltipProvider>
            <Tooltip v-if="!isWebVersion">
              <TooltipTrigger as-child>
                <Button
                  variant="secondary"
                  :disabled="isValidating"
                  @click="resetSettings"
                >
                  {{ $t("settingsDrawer.reset") }}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {{ $t("settingsDrawer.resetToEnvVariables") }}
              </TooltipContent>
            </Tooltip>
            <Button
              v-else
              variant="secondary"
              :disabled="isValidating"
              @click="resetSettings"
            >
              {{ $t("settingsDrawer.reset") }}
            </Button>
          </TooltipProvider>
        </div>
      </div>
    </SheetContent>
  </Sheet>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { useAppStore } from "@/store/app";
import i18n from "@/i18n";
import { getSettings, persistSettings } from "@/api/settings";
import * as camundaCloudApi from "@/api/camundaCloud";
import { Settings } from "@/types/settings";
import { SnackbarType } from "@/utils/snackbar";
import { Eye, EyeOff, Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";

export default defineComponent({
  name: "SettingsDrawer",

  components: {
    Button,
    Eye,
    EyeOff,
    Input,
    Label,
    Loader2,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger
  },

  data: () => ({
    appStore: useAppStore(),
    settings: {} as Settings,
    settingsToBeSaved: {} as Settings,
    showModelerClientSecret: false,
    showOperateClientSecret: false,
    modelerError: "",
    modelerSuccessMsg: "",
    operateConnectionSuccessMsg: "",
    operateClusterSuccessMsg: "",
    isValidating: false,
    isWebVersion: import.meta.env.VITE_APP_MODE === "web"
  }),

  computed: {
    isUserLoggedIn() {
      return this.appStore.getUserToken() !== null;
    }
  },

  watch: {
    "appStore.areSettingsOpened"() {
      this.handleAfterToggle();
    }
  },

  async mounted() {
    if (Object.keys(this.settings).length === 0) await this.handleAfterToggle();
  },

  methods: {
    async handleAfterToggle() {
      if (!this.appStore.getAreSettingsOpened()) {
        await this.resetSettingsBar();
      } else {
        await this.fetchSettings();
        await this.validateSettings();
      }
    },
    resetSettings() {
      this.settings = {
        modelerClientId: import.meta.env.VITE_MODELER_CLIENT_ID || "",
        modelerClientSecret: import.meta.env.VITE_MODELER_CLIENT_SECRET || "",
        operateClientId: import.meta.env.VITE_OPERATE_CLIENT_ID || "",
        operateClientSecret: import.meta.env.VITE_OPERATE_CLIENT_SECRET || "",
        operateRegionId: import.meta.env.VITE_OPERATE_REGION_ID || "",
        operateClusterId: import.meta.env.VITE_OPERATE_CLUSTER_ID || ""
      };
    },
    async saveSettings() {
      const areSettingsValid = await this.validateSettings();

      try {
        await persistSettings(this.settingsToBeSaved);
      } catch {
        await this.appStore.showSnackbar(
          this.$t("settingsDrawer.saveErrorMsg"),
          SnackbarType.ERROR
        );
        return;
      }

      if (areSettingsValid) {
        this.closeSettingsDrawer();
      } else {
        if (this.settingsToBeSaved.modelerClientSecret)
          this.modelerSuccessMsg = this.$t("settingsDrawer.savedSuccessfully");
        if (this.settingsToBeSaved.operateClientSecret)
          this.operateConnectionSuccessMsg = this.$t(
            "settingsDrawer.savedSuccessfully"
          );
        if (this.settingsToBeSaved.operateClusterId)
          this.operateClusterSuccessMsg = this.$t(
            "settingsDrawer.savedSuccessfully"
          );
      }
    },
    async validateSettings(): Promise<boolean> {
      const languages = i18n.global.availableLocales;
      this.isValidating = true;
      const operateConnectionInvalidMsgs = languages.map(
        (lang) =>
          i18n.global.getLocaleMessage(lang).settingsDrawer
            .operateConnectionInvalidMsg
      );
      const operateConnectionError = this.appStore.getOperateConnectionError();
      const operateClusterInvalidMsgs = languages.map(
        (lang) =>
          i18n.global.getLocaleMessage(lang).settingsDrawer
            .operateClusterInvalidMsg
      );
      const operateClusterError = this.appStore.getOperateClusterError();
      this.resetValidation();

      const [
        isModelerConnectionValid,
        { valid: isOperateConnectionValid, token: operateToken }
      ] = await Promise.all([
        this.validateModelerConnection(),
        this.validateOperateConnection()
      ]);
      const isOperateClusterValid = await this.validateOperateClusterId(
        operateToken || ""
      );
      this.isValidating = false;

      if (!operateConnectionInvalidMsgs.includes(operateConnectionError)) {
        this.appStore.setOperateConnectionError(operateConnectionError);
      }

      if (!operateClusterInvalidMsgs.includes(operateClusterError)) {
        this.appStore.setOperateClusterError(operateClusterError);
      }

      this.settingsToBeSaved = { ...this.settings };

      if (
        !isModelerConnectionValid ||
        !isOperateConnectionValid ||
        !isOperateClusterValid
      ) {
        if (!isModelerConnectionValid) {
          this.modelerError = this.$t(
            "settingsDrawer.modelerConnectionInvalidMsg"
          );
          this.settingsToBeSaved.modelerClientId = "";
          this.settingsToBeSaved.modelerClientSecret = "";
        }
        if (!isOperateConnectionValid) {
          this.appStore.setOperateConnectionError(
            this.$t("settingsDrawer.operateConnectionInvalidMsg")
          );
          this.settingsToBeSaved.operateClientId = "";
          this.settingsToBeSaved.operateClientSecret = "";
        }
        if (!isOperateClusterValid) {
          this.appStore.setOperateClusterError(
            this.$t("settingsDrawer.operateClusterInvalidMsg")
          );
          this.settingsToBeSaved.operateRegionId = "";
          this.settingsToBeSaved.operateClusterId = "";
        }
        return false;
      }
      return true;
    },
    async validateModelerConnection(): Promise<boolean> {
      const { modelerClientId, modelerClientSecret } = this.settings;
      if (!modelerClientId && !modelerClientSecret) return true;
      if (!modelerClientId || !modelerClientSecret) return false;
      try {
        await camundaCloudApi.fetchToken(modelerClientId, modelerClientSecret);
        return true;
      } catch {
        return false;
      }
    },
    async validateOperateConnection(): Promise<{
      valid: boolean;
      token: string | null;
    }> {
      const { operateClientId, operateClientSecret } = this.settings;
      if (!operateClientId && !operateClientSecret)
        return { valid: true, token: null };
      if (!operateClientId || !operateClientSecret)
        return { valid: false, token: null };
      try {
        const token = await camundaCloudApi.fetchToken(
          operateClientId,
          operateClientSecret,
          "operate.camunda.io"
        );
        return { valid: true, token };
      } catch {
        return { valid: false, token: null };
      }
    },
    async validateOperateClusterId(operateToken: string): Promise<boolean> {
      const { operateRegionId, operateClusterId } = this.settings;
      if (!operateRegionId && !operateClusterId) return true;
      if (!operateRegionId || !operateClusterId) return false;
      try {
        await camundaCloudApi.fetchProcessInstances({
          token: operateToken,
          regionId: this.settings.operateRegionId,
          clusterId: this.settings.operateClusterId
        });
        return true;
      } catch {
        return false;
      }
    },
    async resetSettingsBar() {
      await this.fetchSettings();
      this.resetValidation();
      this.showModelerClientSecret = false;
      this.showOperateClientSecret = false;
    },
    resetValidation() {
      this.modelerError = "";
      this.appStore.setOperateClusterError("");
      this.appStore.setOperateConnectionError("");
    },
    async fetchSettings() {
      if (this.isWebVersion && !this.isUserLoggedIn) {
        return;
      }
      this.settings = (await getSettings()) ?? ({} as Settings);

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
    closeSettingsDrawer() {
      this.appStore.setAreSettingsOpened(false);
    },
    resetMessagesModeler() {
      this.modelerError = "";
      this.modelerSuccessMsg = "";
    },
    resetMessagesOperateConnection() {
      this.appStore.setOperateConnectionError("");
      this.operateConnectionSuccessMsg = "";
    },
    resetMessagesOperateCluster() {
      this.appStore.setOperateClusterError("");
      this.operateClusterSuccessMsg = "";
    }
  }
});
</script>

<style scoped></style>
