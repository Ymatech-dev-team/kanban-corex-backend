// Presets de filtro do board — por usuário e por cliente (Project). [filtros-salvos-board]

/** Payload dos filtros salvos. Espelha o BoardFilters do front; validado por whitelist na rota. */
export interface BoardFilters {
  resp?: string; // "none" (sem responsável) ou userId; ausente = todos
  status?: "TODO" | "DOING" | "DONE";
  prio?: "HIGH" | "MEDIUM" | "LOW";
  prazo?: "atrasadas" | "hoje" | "semana";
}

export interface PresetRecord {
  id: string;
  orgId: string;
  projectId: string;
  userId: string;
  name: string;
  filters: BoardFilters;
  createdAt: Date;
}

export interface NewPreset {
  orgId: string;
  projectId: string;
  userId: string;
  name: string;
  filters: BoardFilters;
}

export interface PresetRepo {
  /** Presets do usuário naquele cliente (mais recentes primeiro). orgId+userId sempre no WHERE. */
  listByScope(orgId: string, projectId: string, userId: string): Promise<PresetRecord[]>;
  findById(id: string, orgId: string): Promise<PresetRecord | null>;
  countByScope(orgId: string, projectId: string, userId: string): Promise<number>;
  create(p: NewPreset): Promise<PresetRecord>;
  update(id: string, orgId: string, patch: { name?: string; filters?: BoardFilters }): Promise<PresetRecord>;
  delete(id: string, orgId: string): Promise<void>;
}

/** DTO que a UI consome. Não expõe orgId/userId. */
export interface PresetItem {
  id: string;
  name: string;
  filters: BoardFilters;
  createdAt: string; // ISO
}
