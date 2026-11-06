import type { PrismaClient } from "@prisma/client";
import type { AttachmentRecord, AttachmentRepo, NewAttachment } from "./types.js";
import { withLegacyTaskWrite } from "../workflow/legacy-write.js";

type Row = {
  id: string;
  taskId: string;
  uploaderId: string;
  uploaderName: string;
  fileName: string;
  contentType: string;
  size: number;
  url: string;
  pathname: string;
  createdAt: Date;
};
function toRecord(a: Row): AttachmentRecord {
  return { ...a };
}

export class PrismaAttachmentRepo implements AttachmentRepo {
  constructor(private readonly db: PrismaClient, private readonly workflowEnabled = false) {}

  async assertWritable(taskId: string, orgId: string): Promise<void> {
    await withLegacyTaskWrite(this.db, this.workflowEnabled, taskId, async () => undefined, { orgId });
  }

  async create(a: NewAttachment): Promise<AttachmentRecord> {
    // snapshot do nome do uploader (sobrevive a remoção/renome). [detalhe-tarefa RF-A4]
    return withLegacyTaskWrite(this.db, this.workflowEnabled, a.taskId, async (tx) => {
    const u = await tx.user.findUnique({ where: { id: a.uploaderId }, select: { name: true } });
    const row = await tx.taskAttachment.create({
      data: {
        taskId: a.taskId,
        orgId: a.orgId,
        uploaderId: a.uploaderId,
        uploaderName: u?.name ?? a.uploaderId,
        fileName: a.fileName,
        contentType: a.contentType,
        size: a.size,
        url: a.url,
        pathname: a.pathname,
      },
    });
    return toRecord(row);
    }, { orgId: a.orgId });
  }

  async listByTask(taskId: string, orgId: string): Promise<AttachmentRecord[]> {
    const rows = await this.db.taskAttachment.findMany({
      where: { taskId, orgId }, // orgId sempre no WHERE — cross-org [SEC]
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return rows.map(toRecord);
  }

  async findById(id: string, orgId: string): Promise<AttachmentRecord | null> {
    const row = await this.db.taskAttachment.findFirst({ where: { id, orgId } });
    return row ? toRecord(row) : null;
  }

  async findByPathname(pathname: string, orgId: string): Promise<AttachmentRecord | null> {
    const row = await this.db.taskAttachment.findFirst({ where: { pathname, orgId } });
    return row ? toRecord(row) : null;
  }

  async delete(id: string, orgId: string): Promise<void> {
    const row = await this.db.taskAttachment.findFirst({ where: { id, orgId }, select: { taskId: true } });
    if (!row) return;
    await withLegacyTaskWrite(this.db, this.workflowEnabled, row.taskId, (tx) => tx.taskAttachment.deleteMany({ where: { id, orgId } }), { orgId });
  }
}
