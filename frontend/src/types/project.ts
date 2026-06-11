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

/**
 * An invitation for an e-mail address without a ProA account yet. It is
 * resolved into a membership on the invitee's first sign-in (ADR-0003).
 */
export interface PendingInvitation {
  id: number;
  email: string;
  role: string;
  createdAt: string;
}
