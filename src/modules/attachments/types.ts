// Anexos de tarefa. O binário mora no Vercel Blob (url); esta tabela é só o registro/metadata. [anexos]

export interface AttachmentRecord {
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
}

export interface NewAttachment {
  taskId: string;
  orgId: string;
  uploaderId: string; // uploaderName é resolvido (snapshot) no repo
  fileName: string;
  contentType: string;
  size: number;
  url: string;
  pathname: string;
}

export interface AttachmentRepo {
  /** Cria o registro (snapshot do nome do uploader). `pathname` é único (idempotência do confirm). */
  create(a: NewAttachment): Promise<AttachmentRecord>;
  listByTask(taskId: string, orgId: string): Promise<AttachmentRecord[]>;
  findById(id: string, orgId: string): Promise<AttachmentRecord | null>;
  findByPathname(pathname: string, orgId: string): Promise<AttachmentRecord | null>;
  delete(id: string, orgId: string): Promise<void>;
}

/** DTO que a UI consome (sem a URL crua — download é via endpoint que assina). [anexos B] */
export interface AttachmentItem {
  id: string;
  taskId: string;
  fileName: string;
  contentType: string;
  size: number;
  uploaderName: string;
  createdAt: string; // ISO
  canRemove: boolean; // uploader OU moderador (a barreira real é o backend)
}
