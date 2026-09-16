import { AppError } from "../../lib/errors.js";
import type { SessionContext } from "../authz/types.js";
import type { BoardFilters, PresetItem, PresetRecord, PresetRepo } from "./types.js";

export const MAX_PRESETS_PER_SCOPE = 20; // teto de sanidade por (usuário, cliente)
export const MAX_NAME_LEN = 60;

/** Normaliza pra comparar duplicado: trim + minúsculas + colapsa espaços internos. */
function norm(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True se algum filtro está setado — preset "vazio" não faz sentido. */
export function hasAnyFilter(f: BoardFilters): boolean {
  return f.resp !== undefined || f.status !== undefined || f.prio !== undefined || f.prazo !== undefined;
}

export class BoardFilterService {
  constructor(private readonly repo: PresetRepo) {}

  async list(session: SessionContext, projectId: string): Promise<PresetItem[]> {
    const rows = await this.repo.listByScope(session.orgId, projectId, session.userId);
    return rows.map(toItem);
  }

  async create(
    session: SessionContext,
    projectId: string,
    name: string,
    filters: BoardFilters,
  ): Promise<PresetItem> {
    const clean = name.trim();
    if (!clean) throw new AppError("VALIDACAO", "Dê um nome ao preset");
    if (clean.length > MAX_NAME_LEN) throw new AppError("VALIDACAO", "Nome muito longo");
    if (!hasAnyFilter(filters)) throw new AppError("VALIDACAO", "Nenhum filtro para salvar");

    const existing = await this.repo.listByScope(session.orgId, projectId, session.userId);
    if (existing.length >= MAX_PRESETS_PER_SCOPE) {
      throw new AppError("VALIDACAO", `Limite de ${MAX_PRESETS_PER_SCOPE} presets por cliente`);
    }
    if (existing.some((p) => norm(p.name) === norm(clean))) {
      throw new AppError("CONFLITO", "Já existe um preset com esse nome");
    }

    try {
      const row = await this.repo.create({
        orgId: session.orgId,
        projectId,
        userId: session.userId,
        name: clean,
        filters,
      });
      return toItem(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError("CONFLITO", "Já existe um preset com esse nome");
      if (isFkViolation(e)) throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
      throw e;
    }
  }

  async update(
    session: SessionContext,
    presetId: string,
    projectId: string,
    patch: { name?: string; filters?: BoardFilters },
  ): Promise<PresetItem> {
    const row = await this.mine(session, presetId, projectId);

    const next: { name?: string; filters?: BoardFilters } = {};
    if (patch.name !== undefined) {
      const clean = patch.name.trim();
      if (!clean) throw new AppError("VALIDACAO", "Dê um nome ao preset");
      if (clean.length > MAX_NAME_LEN) throw new AppError("VALIDACAO", "Nome muito longo");
      const others = (await this.repo.listByScope(session.orgId, projectId, session.userId)).filter(
        (p) => p.id !== presetId,
      );
      if (others.some((p) => norm(p.name) === norm(clean))) {
        throw new AppError("CONFLITO", "Já existe um preset com esse nome");
      }
      next.name = clean;
    }
    if (patch.filters !== undefined) {
      if (!hasAnyFilter(patch.filters)) throw new AppError("VALIDACAO", "Nenhum filtro para salvar");
      next.filters = patch.filters;
    }
    if (next.name === undefined && next.filters === undefined) return toItem(row);

    try {
      const updated = await this.repo.update(presetId, session.orgId, next);
      return toItem(updated);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError("CONFLITO", "Já existe um preset com esse nome");
      throw e;
    }
  }

  async remove(session: SessionContext, presetId: string, projectId: string): Promise<void> {
    await this.mine(session, presetId, projectId);
    await this.repo.delete(presetId, session.orgId);
  }

  /** Preset do próprio usuário nesse cliente, ou 404 (não confirma existência alheia). [SEC anti-IDOR] */
  private async mine(session: SessionContext, presetId: string, projectId: string): Promise<PresetRecord> {
    const row = await this.repo.findById(presetId, session.orgId);
    if (!row || row.userId !== session.userId || row.projectId !== projectId) {
      throw new AppError("NAO_ENCONTRADO", "Preset não encontrado");
    }
    return row;
  }
}

function toItem(r: PresetRecord): PresetItem {
  return { id: r.id, name: r.name, filters: r.filters, createdAt: r.createdAt.toISOString() };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}
function isFkViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2003";
}
