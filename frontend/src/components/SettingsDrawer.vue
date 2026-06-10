<template>
  <v-navigation-drawer
    v-model="appStore.areSettingsOpened"
    location="right"
    temporary
    width="400"
  >
    <div class="d-flex flex-column ma-3 ms-4">
      <div class="d-flex align-center">
        <p class="text-h6">{{ $t("general.settings") }}</p>
        <v-btn class="ms-auto" variant="text" icon @click="closeSettingsDrawer">
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </div>
      <div class="mt-2">
        <p class="text-subtitle-1 text-grey-darken-2 mb-1">
          {{ $t("settingsDrawer.geminiApiKey") }}
        </p>
        <v-text-field
          v-model="settings.geminiApiKey"
          :label="$t('settingsDrawer.apiKey')"
          :type="showApiKey ? 'text' : 'password'"
          :append-inner-icon="showApiKey ? 'mdi-eye' : 'mdi-eye-off'"
          :error-messages="apiKeyError"
          :loading="isValidating"
          :disabled="isValidating"
          :messages="apiKeySuccessMsg"
          @click:append-inner="showApiKey = !showApiKey"
          @input="resetMessagesApiKey"
        >
        </v-text-field>
      </div>
      <div class="mt-2">
        <p class="text-subtitle-1 text-grey-darken-2 mb-1">
          {{ $t("settingsDrawer.camundaModelerConnection") }}
        </p>
        <v-text-field
          v-model="settings.modelerClientId"
          :label="$t('general.clientId')"
          hide-details
          class="mb-2"
          :error-messages="modelerError"
          :loading="isValidating"
          :disabled="isValidating"
          @input="resetMessagesModeler"
        >
        </v-text-field>
        <v-text-field
          v-model="settings.modelerClientSecret"
          :loading="isValidating"
          :disabled="isValidating"
          :label="$t('general.clientSecret')"
          :type="showModelerClientSecret ? 'text' : 'password'"
          :append-inner-icon="
            showModelerClientSecret ? 'mdi-eye' : 'mdi-eye-off'
          "
          :error-messages="modelerError"
          :messages="modelerSuccessMsg"
          @click:append-inner="
            showModelerClientSecret = !showModelerClientSecret
          "
          @input="resetMessagesModeler"
        >
        </v-text-field>
      </div>
      <div class="mt-2 mb-4">
        <p class="text-subtitle-1 text-grey-darken-2 mb-1">
          {{ $t("settingsDrawer.camundaOperateConnection") }}
        </p>
        <v-text-field
          v-model="settings.operateClientId"
          :label="$t('general.clientId')"
          :error-messages="appStore.operateConnectionError"
          hide-details
          class="mb-2"
          :loading="isValidating"
          :disabled="isValidating"
          @input="resetMessagesOperateConnection"
        >
        </v-text-field>
        <v-text-field
          v-model="settings.operateClientSecret"
          :label="$t('general.clientSecret')"
          :type="showOperateClientSecret ? 'text' : 'password'"
          :append-inner-icon="
            showOperateClientSecret ? 'mdi-eye' : 'mdi-eye-off'
          "
          :error-messages="appStore.operateConnectionError"
          :loading="isValidating"
          :disabled="isValidating"
          :messages="operateConnectionSuccessMsg"
          @click:append-inner="
            showOperateClientSecret = !showOperateClientSecret
          "
          @input="resetMessagesOperateConnection"
        >
        </v-text-field>
        <v-text-field
          v-model="settings.operateRegionId"
          :label="$t('settingsDrawer.regionId')"
          :error-messages="appStore.operateClusterError"
          :loading="isValidating"
          :disabled="isValidating"
          hide-details
          class="mb-2"
          @input="resetMessagesOperateCluster"
        >
        </v-text-field>
        <v-text-field
          v-model="settings.operateClusterId"
          :label="$t('settingsDrawer.clusterId')"
          :error-messages="appStore.operateClusterError"
          :loading="isValidating"
          :disabled="isValidating"
          :messages="operateClusterSuccessMsg"
          @input="resetMessagesOperateCluster"
        >
        </v-text-field>
      </div>
      <div class="d-flex">
        <div class="mt-3 me-5">
          <v-btn color="primary" @click="saveSettings">{{
            $t("general.save")
          }}</v-btn>
        </div>
        <div class="mt-3">
          <v-tooltip
            v-if="!isWebVersion"
            :text="$t('settingsDrawer.resetToEnvVariables')"
            location="bottom"
          >
            <template #activator="{ props }">
              <v-btn v-bind="props" color="grey" @click="resetSettings">{{
                $t("settingsDrawer.reset")
              }}</v-btn>
            </template>
          </v-tooltip>
          <v-btn v-else color="grey" @click="resetSettings">{{
            $t("settingsDrawer.reset")
          }}</v-btn>
        </div>
      </div>
    </div>
  </v-navigation-drawer>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { useAppStore } from "@/store/app";
import { GoogleGenerativeAI } from "@google/generative-ai";
import i18n from "@/i18n";
import { getSettings, persistSettings } from "@/api/settings";
import * as camundaCloudApi from "@/api/camundaCloud";
import { Settings } from "@/types/settings";
import { SnackbarType } from "@/utils/snackbar";

export default defineComponent({
  name: "SettingsDrawer",

  data: () => ({
    appStore: useAppStore(),
    settings: {} as Settings,
    settingsToBeSaved: {} as Settings,
    showApiKey: false,
    showModelerClientSecret: false,
    showOperateClientSecret: false,
    apiKeyError: "",
    modelerError: "",
    apiKeySuccessMsg: "",
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
        geminiApiKey: import.meta.env.VITE_GEMINI_API_KEY || "",
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
        if (this.settingsToBeSaved.geminiApiKey)
          this.apiKeySuccessMsg = this.$t("settingsDrawer.savedSuccessfully");
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
        isAPIKeyValid,
        isModelerConnectionValid,
        { valid: isOperateConnectionValid, token: operateToken }
      ] = await Promise.all([
        this.validateAPIKey(),
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
        !isAPIKeyValid ||
        !isModelerConnectionValid ||
        !isOperateConnectionValid ||
        !isOperateClusterValid
      ) {
        if (!isAPIKeyValid) {
          this.apiKeyError = this.$t("settingsDrawer.apiKeyInvalidMsg");
          this.settingsToBeSaved.geminiApiKey = "";
        }
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
    async validateAPIKey(): Promise<boolean> {
      const { geminiApiKey } = this.settings;
      if (!geminiApiKey) {
        return true;
      }
      const genAI = new GoogleGenerativeAI(geminiApiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

      try {
        await model.generateContent("write yes");
        return true;
      } catch {
        return false;
      }
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
      this.showApiKey = false;
      this.showModelerClientSecret = false;
      this.showOperateClientSecret = false;
    },
    resetValidation() {
      this.apiKeyError = "";
      this.modelerError = "";
      this.appStore.setOperateClusterError("");
      this.appStore.setOperateConnectionError("");
    },
    async fetchSettings() {
      if (this.isWebVersion && !this.isUserLoggedIn) {
        return;
      }
      this.settings = (await getSettings()) ?? ({} as Settings);

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
    closeSettingsDrawer() {
      this.appStore.setAreSettingsOpened(false);
    },
    resetMessagesApiKey() {
      this.apiKeyError = "";
      this.apiKeySuccessMsg = "";
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
