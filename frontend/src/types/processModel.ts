export interface ProcessModelInformation {
  id: number;
  bpmnProcessId: string;
  processName: string;
  description: string;
  createdAt: string;
  childrenIds: number[];
  processType: string;
}

export interface ProcessModelNode extends ProcessModelInformation {
  children: ProcessModelNode[];
}

export interface ProcessElement {
  elementId: string;
  label: string;
}

export interface ProcessDetails {
  id: number;
  name: string;
  description: string;
  startEvents: ProcessElement[];
  endEvents: ProcessElement[];
  intermediateCatchEvents: ProcessElement[];
  intermediateThrowEvents: ProcessElement[];
  activities: ProcessElement[];
}
