import apiClient from "@/api/client";
import { PendingInvitation, Project, ProjectVersion } from "@/types/project";

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

/**
 * Whether an invite-by-email created a membership right away (the invitee
 * already has an account) or stored a pending invitation (ADR-0003).
 */
export type InviteMemberStatus = "MEMBER_ADDED" | "INVITATION_PENDING";

export interface InviteMemberResponse {
  status: InviteMemberStatus;
}

export const inviteMember = async (
  projectId: number,
  email: string
): Promise<InviteMemberResponse> => {
  const formData = new FormData();
  formData.append("email", email);

  const { data } = await apiClient.post<InviteMemberResponse>(
    `/project/${projectId}/contributor`,
    formData
  );
  return data;
};

export const getInvitations = async (
  projectId: number
): Promise<PendingInvitation[]> => {
  const { data } = await apiClient.get<PendingInvitation[]>(
    `/project/${projectId}/invitation`
  );
  return data;
};

export const revokeInvitation = async (
  projectId: number,
  invitationId: number
): Promise<void> => {
  await apiClient.delete(`/project/${projectId}/invitation/${invitationId}`);
};
