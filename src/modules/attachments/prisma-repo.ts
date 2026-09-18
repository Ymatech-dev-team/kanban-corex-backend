import type { PrismaClient } from "@prisma/client";
import type { AttachmentRecord, AttachmentRepo, NewAttachment } from "./types.js";

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
  constructor(private readonly db: PrismaClient) {}

  async create(a: NewAttachment): Promise<AttachmentRecord> {
    // snapshot do nome do uploader (sobrevive a remoção/renome). [detalhe-tarefa RF-A4]
    const u = await this.db.user.findUnique({ where: { id: a.uploaderId }, select: { name: true } });
    const row = await this.db.taskAttachment.create({
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
    await this.db.taskAttachment.deleteMany({ where: { id, orgId } }); // orgId no WHERE (defense-in-depth)
  }
}
