import apiClient from "@/api/client";
import { ProcessDetails, ProcessModelInformation } from "@/types/processModel";

export interface ProcessModelUpload {
  file: File;
  fileName: string;
  description: string;
  isCollaboration: boolean;
}

const toFormData = (upload: ProcessModelUpload): FormData => {
  const formData = new FormData();
  formData.append("processModel", upload.file);
  formData.append("fileName", upload.fileName);
  formData.append("description", upload.description);
  formData.append("isCollaboration", upload.isCollaboration ? "true" : "false");
  return formData;
};

export const getProcessModels = async (
  projectVersionId: number
): Promise<ProcessModelInformation[]> => {
  const { data } = await apiClient.get<ProcessModelInformation[]>(
    `/project/${projectVersionId}/process-model`
  );
  return data;
};

export const uploadProcessModel = async (
  projectVersionId: number,
  upload: ProcessModelUpload
): Promise<number> => {
  const { data } = await apiClient.post<number>(
    `/project/${projectVersionId}/process-model`,
    toFormData(upload)
  );
  return data;
};

export const replaceProcessModel = async (
  projectVersionId: number,
  processModelId: number,
  upload: ProcessModelUpload
): Promise<void> => {
  await apiClient.post(
    `/project/${projectVersionId}/process-model/${processModelId}`,
    toFormData(upload)
  );
};

export const deleteProcessModel = async (
  processModelId: number
): Promise<void> => {
  await apiClient.delete(`/process-model/${processModelId}`);
};

export const getProcessModelXml = async (
  processModelId: number | string
): Promise<string> => {
  const { data } = await apiClient.get<string>(
    `/process-model/${processModelId}`
  );
  return data;
};

export const getProcessModelDetails = async (
  processModelId: number | string
): Promise<ProcessDetails> => {
  const { data } = await apiClient.get<ProcessDetails>(
    `/process-model/${processModelId}/details`
  );
  return data;
};
