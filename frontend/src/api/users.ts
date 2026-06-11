import apiClient from "@/api/client";
import { UserData } from "@/types/user";

/**
 * The current user is the only user the app reads (a read-cache of the
 * Keycloak identity). User management happens in the Keycloak consoles.
 */
export const getCurrentUser = async (): Promise<UserData> => {
  const { data } = await apiClient.get<UserData>("/user");
  return data;
};
