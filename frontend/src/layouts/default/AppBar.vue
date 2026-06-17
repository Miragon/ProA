<template>
  <header
    class="tw:bg-primary tw:text-primary-foreground tw:sticky tw:top-0 tw:z-30 tw:flex tw:h-16 tw:items-center tw:gap-2 tw:px-2 tw:shadow-sm"
  >
    <Sheet v-model:open="drawer">
      <SheetTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          class="tw:text-primary-foreground tw:hover:bg-white/10 tw:hover:text-primary-foreground"
        >
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" class="tw:w-72 tw:p-0">
        <SheetHeader class="tw:sr-only">
          <SheetTitle>{{ $t("general.menu") }}</SheetTitle>
        </SheetHeader>
        <nav class="tw:flex tw:flex-col tw:gap-1 tw:px-2 tw:py-4">
          <Button
            v-for="item in items"
            :key="item.title"
            variant="ghost"
            class="tw:justify-start"
            :disabled="
              !store.getSelectedProjectId() &&
              item.title !== $t('navigation.projectOverview')
            "
            @click="navigateTo(item.route)"
          >
            {{ item.title }}
          </Button>
        </nav>
      </SheetContent>
    </Sheet>

    <h1 class="tw:text-lg tw:font-medium">ProA – {{ currentRouteName }}</h1>

    <div class="tw:flex-1"></div>

    <TooltipProvider>
      <Tooltip v-if="webVersion && isUserLoggedIn">
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="tw:text-primary-foreground tw:hover:bg-white/10 tw:hover:text-primary-foreground"
            @click="openDialog(SelectedDialog.PROFILE)"
          >
            <CircleUserRound />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {{ $t("general.myProfile") }}
        </TooltipContent>
      </Tooltip>

      <Tooltip v-if="webVersion && isUserLoggedIn">
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="tw:text-primary-foreground tw:hover:bg-white/10 tw:hover:text-primary-foreground"
            @click="signOut"
          >
            <LogOut />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {{ $t("general.signOut") }}
        </TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            variant="ghost"
            class="tw:text-primary-foreground tw:hover:bg-white/10 tw:hover:text-primary-foreground"
          >
            {{ selectedLanguage.toUpperCase() }}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            v-for="language in availableLanguages"
            :key="language.code"
            @click="changeLanguage(language.code)"
          >
            {{ language.name }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tooltip v-if="isUserLoggedIn">
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="tw:text-primary-foreground tw:hover:bg-white/10 tw:hover:text-primary-foreground"
            @click="toggleSettings"
          >
            <Settings />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {{ $t("general.settings") }}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </header>

  <SettingsDrawer />

  <AuthenticationDialog v-if="webVersion" />
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { SelectedDialog, useAppStore } from "@/store/app";
import SettingsDrawer from "@/components/SettingsDrawer.vue";
import i18n from "@/i18n";
import AuthenticationDialog from "@/components/Authentication/AuthenticationDialog.vue";
import { LanguageCode } from "@/types/language";
import { CircleUserRound, LogOut, Menu, Settings } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";

interface Language {
  code: LanguageCode;
  name: string;
}

export default defineComponent({
  components: {
    AuthenticationDialog,
    SettingsDrawer,
    Button,
    CircleUserRound,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    LogOut,
    Menu,
    Settings,
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger
  },

  data: () => {
    const store = useAppStore();

    return {
      store,
      drawer: false as boolean,
      group: null,
      selectedLanguage: store.getSelectedLanguage() as LanguageCode,
      webVersion: (import.meta.env.VITE_APP_MODE === "web") as boolean,
      SelectedDialog: SelectedDialog
    };
  },

  computed: {
    availableLanguages(): Language[] {
      const availableLanguages: Language[] = [
        {
          code: "de",
          name: this.$t("general.german")
        },
        {
          code: "en",
          name: this.$t("general.english")
        }
      ];
      return availableLanguages.sort((language1, language2) =>
        language1.name.localeCompare(language2.name)
      );
    },
    items() {
      return [
        {
          title: this.$t("navigation.projectOverview"),
          route: "/"
        },
        {
          title: this.$t("navigation.processList"),
          route: "/ProcessList"
        },
        {
          title: this.$t("navigation.c8Import"),
          route: "/CamundaCloudImport"
        },
        {
          title: this.$t("navigation.processMap"),
          route: "/ProcessMap"
        }
      ];
    },
    currentRouteName() {
      return this.$t(
        "navigation." + this.lowerFirstLetter(this.$route.name?.toString())
      );
    },
    isUserLoggedIn() {
      return this.store.getUserToken() != null;
    }
  },

  watch: {
    group() {
      this.drawer = false;
    }
  },

  async mounted() {
    i18n.global.locale = this.selectedLanguage;
  },
  methods: {
    navigateTo(route: string) {
      this.drawer = false;
      this.$router.push({ path: route });
    },
    changeLanguage(language: LanguageCode) {
      this.selectedLanguage = language;
      this.store.setSelectedLanguage(language);
      i18n.global.locale = language;
    },
    lowerFirstLetter(s: string | undefined) {
      if (!s) {
        return "";
      }
      return s.charAt(0).toLowerCase() + s.slice(1);
    },
    toggleSettings() {
      this.store.setAreSettingsOpened(!this.store.getAreSettingsOpened());
    },
    async signOut() {
      // Lazy import: desktop mode (which has no sign-out button anyway)
      // must never load the OIDC machinery.
      const { signoutRedirect } = await import("@/auth/oidc");
      // Start the sign-out first: clearing the store triggers watchers
      // whose navigations would otherwise kick off a sign-in redirect.
      const redirect = signoutRedirect();
      this.store.setUserToken(null);
      this.store.setUserRole(null);
      await redirect;
    },
    openDialog(dialog: SelectedDialog) {
      this.store.setSelectedDialog(dialog);
    }
  }
});
</script>

<style scoped></style>
