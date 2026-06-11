<template>
  <div
    class="tw:mx-auto tw:flex tw:w-full tw:max-w-7xl tw:flex-col tw:gap-4 tw:p-4"
  >
    <div class="tw:relative tw:w-1/2">
      <Search
        class="tw:text-muted-foreground tw:absolute tw:top-1/2 tw:left-2.5 tw:size-4 tw:-translate-y-1/2"
      />
      <Input
        v-model="searchValue"
        type="text"
        :placeholder="$t('general.search')"
        class="tw:px-8"
      />
      <Button
        v-if="searchValue"
        variant="ghost"
        size="icon-sm"
        type="button"
        class="tw:absolute tw:top-1/2 tw:right-1 tw:-translate-y-1/2"
        @click="searchValue = ''"
      >
        <X />
        <span class="tw:sr-only">{{ $t("general.close") }}</span>
      </Button>
    </div>
    <TooltipProvider>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{{ $t("authentication.id") }}</TableHead>
            <TableHead>{{ $t("authentication.email") }}</TableHead>
            <TableHead>{{ $t("authentication.firstName") }}</TableHead>
            <TableHead>{{ $t("authentication.lastName") }}</TableHead>
            <TableHead>{{ $t("authentication.role") }}</TableHead>
            <TableHead>{{ $t("general.createdOn") }}</TableHead>
            <TableHead>{{ $t("general.lastModifiedOn") }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="item in usersShown" :key="item.id">
            <TableCell>{{ item.id }}</TableCell>
            <TableCell>{{ item.email }}</TableCell>
            <TableCell>{{ item.firstName }}</TableCell>
            <TableCell>{{ item.lastName }}</TableCell>
            <TableCell>
              <Badge
                :variant="item.role === Role.ADMIN ? 'default' : 'secondary'"
              >
                {{ $t(`authentication.${item.role.toLowerCase()}`) }}
              </Badge>
            </TableCell>
            <TableCell>{{ getLocaleDate(item.createdAt) }}</TableCell>
            <TableCell>{{ getLocaleDate(item.modifiedAt) }}</TableCell>
            <TableCell>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    @click="openEditUser(item)"
                  >
                    <Pencil />
                    <span class="tw:sr-only">
                      {{ $t("manageUsers.editProfile") }}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {{ $t("manageUsers.editProfile") }}
                </TooltipContent>
              </Tooltip>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </TooltipProvider>
  </div>
  <EditUserDialog
    :show-dialog="showDialog"
    :user-id="editUser.id"
    :user-email="editUser.email"
    :user-first-name="editUser.firstName"
    :user-last-name="editUser.lastName"
    :user-created-at="editUser.createdAt"
    :user-modified-at="editUser.modifiedAt"
    :own-user-id="userId"
    @delete-user="deleteUser"
    @close="closeEditUser"
    @fetch-users="fetchUsers"
  />
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { UserData } from "@/types/user";
import { getAllUsers, getCurrentUser } from "@/api/users";
import { useAppStore } from "@/store/app";
import EditUserDialog from "@/components/ManageUsers/EditUserDialog.vue";
import { Role } from "@/components/ProcessMap/types";
import { Pencil, Search, X } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";

export default defineComponent({
  name: "ManageUsers",
  components: {
    EditUserDialog,
    Badge,
    Button,
    Input,
    Pencil,
    Search,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    X
  },

  data() {
    return {
      userId: -1 as number,
      users: [] as UserData[],
      usersShown: [] as UserData[],
      store: useAppStore(),
      searchValue: "" as string,
      showDialog: false as boolean,
      editUser: {} as UserData,
      Role: Role
    };
  },

  computed: {
    isUserLoggedIn() {
      return this.store.getUserToken() !== null;
    }
  },

  watch: {
    isUserLoggedIn(newValue) {
      if (!newValue) {
        this.$router.push("/");
      }
    },

    searchValue(newValue) {
      if (!newValue) {
        this.usersShown = [...this.users];
        return;
      }

      this.usersShown = this.users.filter(
        (user) =>
          user.email.toLowerCase().includes(newValue.toLowerCase()) ||
          user.firstName?.toLowerCase().includes(newValue.toLowerCase()) ||
          user.lastName?.toLowerCase().includes(newValue.toLowerCase()) ||
          this.$t(`authentication.${user.role.toLowerCase()}`)
            .toLowerCase()
            .includes(newValue.toLowerCase())
      );
    }
  },

  async mounted() {
    await this.fetchUsers();

    this.userId = (await getCurrentUser()).id;
  },

  methods: {
    async fetchUsers() {
      const users = await getAllUsers();
      this.users = users.sort(
        (user1: UserData, user2: UserData) => user1.id - user2.id
      );
      this.usersShown = [...this.users];
    },
    deleteUser(id: number) {
      this.users = this.users.filter((user) => user.id !== id);
      this.usersShown = this.usersShown.filter((user) => user.id !== id);
    },

    openEditUser(user: UserData) {
      this.editUser = { ...user };
      this.showDialog = true;
    },

    closeEditUser() {
      this.showDialog = false;
    },

    getLocaleDate(date: string): string {
      const locales =
        this.store.getSelectedLanguage() === "de" ? "de-DE" : "en-US";
      return new Date(date).toLocaleDateString(locales);
    }
  }
});
</script>
