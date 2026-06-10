import apiClient from "@/api/client";
import {
  Connection,
  DataStore,
  DataStoreConnection,
  MessageFlow,
  Process,
  ProcessElementType
} from "@/components/ProcessMap/types";

export interface ProcessMapData {
  processes: Process[];
  connections: Connection[];
  messageFlows: MessageFlow[];
  dataStores: DataStore[];
  dataStoreConnections: DataStoreConnection[];
}

export interface NewProcessMapConnection {
  callingProcessid: string | number | undefined;
  calledProcessid: string | number | undefined;
  callingElementType: ProcessElementType | null;
  calledElementType: ProcessElementType | null;
  userCreated: boolean;
}

export const getProcessMap = async (
  projectVersionId: number
): Promise<ProcessMapData> => {
  const { data } = await apiClient.get<ProcessMapData>(
    `/project/${projectVersionId}/process-map`
  );
  return data;
};

export const createConnection = async (
  projectVersionId: number,
  connection: NewProcessMapConnection
): Promise<void> => {
  await apiClient.post(
    `/project/${projectVersionId}/process-map/connection`,
    connection
  );
};

export const deleteProcessConnection = async (
  connectionId: number
): Promise<void> => {
  await apiClient.delete(
    `/project/process-map/process-connection/${connectionId}`
  );
};

export const deleteDataStoreConnection = async (
  connectionId: number
): Promise<void> => {
  await apiClient.delete(
    `/project/process-map/datastore-connection/${connectionId}`
  );
};
