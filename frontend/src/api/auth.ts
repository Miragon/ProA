import apiClient from "@/api/client";
import { Role } from "@/components/ProcessMap/types";

export interface RegistrationData {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: Role;
}

export const login = async (
  email: string,
  password: string
): Promise<string> => {
  const { data } = await apiClient.post<string>(
    "/authentication/login",
    { email, password },
    { skipAuth: true }
  );
  return data;
};

export const register = async (
  registration: RegistrationData
): Promise<void> => {
  await apiClient.post("/authentication/register", registration);
};
