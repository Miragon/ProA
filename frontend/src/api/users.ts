import apiClient from "@/api/client";
import { UserData } from "@/types/user";

/**
 * Fields of the currently logged-in user that can be updated. Email and
 * credentials are owned by Keycloak and managed in its account console.
 */
export type CurrentUserUpdate = Partial<
  Pick<UserData, "firstName" | "lastName">
>;

/** Admin update of another user; null means "keep the current value". */
export interface UserUpdate {
  firstName: string | null;
  lastName: string | null;
}

export const getCurrentUser = async (): Promise<UserData> => {
  const { data } = await apiClient.get<UserData>("/user");
  return data;
};

export const getAllUsers = async (): Promise<UserData[]> => {
  const { data } = await apiClient.get<UserData[]>("/user/all");
  return data;
};

export const updateCurrentUser = async (
  update: CurrentUserUpdate
): Promise<void> => {
  await apiClient.patch("/user", update);
};

export const updateUser = async (
  userId: number,
  update: UserUpdate
): Promise<void> => {
  await apiClient.patch(`/user/${userId}`, update);
};

export const deleteUser = async (userId: number): Promise<void> => {
  await apiClient.delete(`/user/${userId}`);
};
