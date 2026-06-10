import apiClient from "@/api/client";
import { Settings } from "@/types/settings";

export const getSettings = async (): Promise<Settings | null> => {
  const { data } = await apiClient.get<Settings | "" | null>("/settings");
  return data || null;
};

const doSettingsExist = async (): Promise<boolean> => {
  try {
    return !!(await getSettings());
  } catch {
    return false;
  }
};

/** Creates the settings if none exist yet, otherwise updates them. */
export const persistSettings = async (settings: Settings): Promise<void> => {
  if (await doSettingsExist()) {
    await apiClient.patch("/settings", settings);
  } else {
    await apiClient.post("/settings", settings);
  }
};
