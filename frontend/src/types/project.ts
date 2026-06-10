export interface Project {
  id: number;
  name: string;
  versions: ProjectVersion[];
  createdAt: string;
  modifiedAt: string;
  projectMembers: ProjectMember[];
}

export interface ProjectVersion {
  id: number;
  name: string;
  createdAt: string;
  modifiedAt: string;
}

export interface ActiveVersionByProject {
  [key: number]: ProjectVersion;
}

export interface ProjectMember {
  id: number;
  firstName: string;
  lastName: string;
  role: string;
}
