import apiClient from "@/api/client";
import { UserData } from "@/types/user";

/** Fields of the currently logged-in user that can be updated. */
export type CurrentUserUpdate = Partial<UserData> & { password?: string };

/** Admin update of another user; null means "keep the current value". */
export interface UserUpdate {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  password: string | null;
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
