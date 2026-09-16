import { Prisma, type PrismaClient } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import type { BoardFilters, NewPreset, PresetRecord, PresetRepo } from "./types.js";

type Row = {
  id: string;
  orgId: string;
  projectId: string;
  userId: string;
  name: string;
  filters: Prisma.JsonValue;
  createdAt: Date;
};
function toRecord(r: Row): PresetRecord {
  return {
    id: r.id,
    orgId: r.orgId,
    projectId: r.projectId,
    userId: r.userId,
    name: r.name,
    filters: (r.filters ?? {}) as BoardFilters,
    createdAt: r.createdAt,
  };
}

export class PrismaBoardFilterRepo implements PresetRepo {
  constructor(private readonly db: PrismaClient) {}

  async listByScope(orgId: string, projectId: string, userId: string): Promise<PresetRecord[]> {
    const rows = await this.db.boardFilterPreset.findMany({
      where: { orgId, projectId, userId }, // orgId+userId sempre no WHERE — isolamento [SEC]
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return rows.map(toRecord);
  }

  async findById(id: string, orgId: string): Promise<PresetRecord | null> {
    const row = await this.db.boardFilterPreset.findFirst({ where: { id, orgId } });
    return row ? toRecord(row) : null;
  }

  async countByScope(orgId: string, projectId: string, userId: string): Promise<number> {
    return this.db.boardFilterPreset.count({ where: { orgId, projectId, userId } });
  }

  async create(p: NewPreset): Promise<PresetRecord> {
    const row = await this.db.boardFilterPreset.create({
      data: {
        orgId: p.orgId,
        projectId: p.projectId,
        userId: p.userId,
        name: p.name,
        filters: p.filters as unknown as Prisma.InputJsonValue,
      },
    });
    return toRecord(row);
  }

  async update(
    id: string,
    orgId: string,
    patch: { name?: string; filters?: BoardFilters },
  ): Promise<PresetRecord> {
    // updateMany p/ manter orgId no WHERE (defense-in-depth); a service já garantiu ownership.
    await this.db.boardFilterPreset.updateMany({
      where: { id, orgId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.filters !== undefined ? { filters: patch.filters as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    const row = await this.db.boardFilterPreset.findFirst({ where: { id, orgId } });
    // updateMany casou 0 linhas (ex.: excluído concorrentemente entre o mine() e aqui) → 404, não 500.
    if (!row) throw new AppError("NAO_ENCONTRADO", "Preset não encontrado");
    return toRecord(row);
  }

  async delete(id: string, orgId: string): Promise<void> {
    await this.db.boardFilterPreset.deleteMany({ where: { id, orgId } }); // orgId no WHERE [SEC]
  }
}
