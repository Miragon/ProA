<template>
  <div
    class="d-flex align-center justify-center"
    style="height: 100%; width: 100%"
  >
    <v-card class="pa-5" width="500">
      <v-card-title class="px-0 pt-0">
        {{ $t("authentication.welcomeBack") }}
      </v-card-title>

      <v-divider />

      <v-card-text>
        <v-form ref="signInForm" @submit.prevent>
          <v-alert
            v-if="message.message !== ''"
            closable
            icon="mdi-alert-circle-outline"
            :text="message.message"
            :type="message.type"
            class="mb-5"
            @click:close="message.message = ''"
          />
          <v-text-field
            ref="emailTextField"
            v-model="email"
            type="email"
            :label="$t('authentication.email')"
            required
            variant="outlined"
            class="my-2"
            :rules="emailRules"
          ></v-text-field>
          <v-text-field
            v-model="password"
            type="password"
            :label="$t('authentication.password')"
            required
            variant="outlined"
            :rules="passwordRules"
          ></v-text-field>
          <v-btn
            type="button"
            color="primary"
            block
            height="50"
            @click="signIn"
          >
            {{ $t("navigation.signIn") }}
          </v-btn>
        </v-form>
      </v-card-text>
    </v-card>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import {
  currentPasswordRules,
  emailRulesSignIn
} from "@/components/Authentication/formValidation";
import { VForm } from "vuetify/components";
import { AxiosError } from "axios";
import { SelectedDialog, useAppStore } from "@/store/app";
import { Message } from "@/components/Authentication/AuthenticationDialog.vue";
import { login } from "@/api/auth";
import { getCurrentUser } from "@/api/users";
import { Role } from "@/components/ProcessMap/types";

export default defineComponent({
  name: "SignIn",

  data() {
    return {
      email: "" as string,
      password: "" as string,
      emailRules: emailRulesSignIn,
      passwordRules: currentPasswordRules,
      store: useAppStore(),
      SelectedDialog: SelectedDialog,
      message: { message: "", type: "error" } as Message,
      defaultMessage: { message: "", type: "error" } as Message
    };
  },

  methods: {
    async signIn() {
      this.message = { ...this.defaultMessage };
      const form = this.$refs.signInForm as VForm;
      form.resetValidation();
      const { valid } = await form.validate();
      if (!valid) {
        return;
      }

      try {
        const token = await login(this.email, this.password);
        this.store.setUserToken(token);

        const user = await getCurrentUser();
        this.store.setUserRole(user.role as Role);

        this.$router.push({ path: "/", state: { showLoggedInBanner: true } });
      } catch (e) {
        if ((e as AxiosError).response?.status === 403) {
          this.message = {
            type: "error",
            message: this.$t("authentication.accountLocked") as string
          };
          return;
        }

        if ((e as AxiosError).response?.status === 429) {
          this.message = {
            type: "error",
            message: this.$t("authentication.tooManyRequests") as string
          };
          return;
        }

        this.message = {
          type: "error",
          message: this.$t("authentication.signInFailed") as string
        };
      }
    }
  }
});
</script>

<style scoped>
@import "../Authentication/authentication.css";
</style>
