export type ProjectBrainCategory =
  | "architecture"
  | "decision"
  | "capability"
  | "constraint"
  | "bug"
  | "fix";

export interface ProjectBrainEntry {
  id: string;
  category: ProjectBrainCategory;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface ProjectBrainSnapshot {
  version: 1;
  projects: Record<string, ProjectBrainEntry[]>;
}

export interface AddProjectBrainEntryInput {
  category: ProjectBrainCategory;
  content: string;
  tags?: string[];
}
