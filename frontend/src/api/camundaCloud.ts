import apiClient from "@/api/client";
import { CamundaProcessModel } from "@/types/camundaCloud";
import { ProcessInstance } from "@/components/ProcessMap/types";

export interface CamundaProcessModelsRequest {
  token: string | null;
  email: string | null;
  regionId: string | null;
  clusterId: string | null;
}

export interface ProcessInstancesRequest {
  token: string;
  regionId: string;
  clusterId: string;
  bpmnProcessId?: string;
}

export const fetchToken = async (
  clientId: string,
  clientSecret: string,
  audience?: string
): Promise<string> => {
  const { data } = await apiClient.post<string>("/camunda-cloud/token", {
    client_id: clientId,
    client_secret: clientSecret,
    audience
  });
  return data;
};

export const fetchProcessModels = async (
  request: CamundaProcessModelsRequest
): Promise<CamundaProcessModel[]> => {
  const { data } = await apiClient.post<{ items: CamundaProcessModel[] }>(
    "/camunda-cloud",
    request
  );
  return data.items;
};

export const importProcessModels = async (
  projectId: number,
  token: string | null,
  selectedProcessModelIds: string[]
): Promise<void> => {
  await apiClient.post(`/camunda-cloud/project/${projectId}/import`, {
    token,
    selectedProcessModelIds
  });
};

export const fetchProcessInstances = async (
  request: ProcessInstancesRequest
): Promise<ProcessInstance[]> => {
  const { data } = await apiClient.post<{ items: ProcessInstance[] }>(
    "/camunda-cloud/process-instances",
    request
  );
  return data.items;
};
