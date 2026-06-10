import apiClient from "@/api/client";
import { Project, ProjectVersion } from "@/types/project";

export const getProjects = async (): Promise<Project[]> => {
  const { data } = await apiClient.get<Project[]>("/project");
  return data;
};

export const getProject = async (projectId: number): Promise<Project> => {
  const { data } = await apiClient.get<Project>(`/project/${projectId}`);
  return data;
};

export const createProject = async (
  name: string,
  versionName: string
): Promise<Project> => {
  const formData = new FormData();
  formData.append("name", name);
  formData.append("version", versionName);

  const { data } = await apiClient.post<Project>("/project", formData);
  return data;
};

export const createProjectVersion = async (
  projectId: number,
  versionName: string
): Promise<ProjectVersion> => {
  const formData = new FormData();
  formData.append("versionName", versionName);

  const { data } = await apiClient.post<ProjectVersion>(
    `/project/${projectId}`,
    formData
  );
  return data;
};

export const deleteProjectVersion = async (
  projectId: number,
  versionId: number
): Promise<void> => {
  await apiClient.delete(`/project/${projectId}/${versionId}`);
};

export const addContributor = async (
  projectId: number,
  email: string
): Promise<void> => {
  const formData = new FormData();
  formData.append("email", email);

  await apiClient.post(`/project/${projectId}/contributor`, formData);
};
