import { randomUUID } from "node:crypto";
import { head, del, issueSignedToken, presignUrl } from "@vercel/blob";
import { AppError } from "../../lib/errors.js";
import type { SessionContext } from "../authz/types.js";
import type { TaskRecord } from "../tasks/types.js";
import type { AttachmentItem, AttachmentRepo } from "./types.js";

// Tipos permitidos EXPLÍCITOS (sem image/* — exclui svg, que pode executar script). [SEC anexos]
export const ALLOWED_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
];
export const MAX_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

/** Prefixo do blob por tarefa — amarra o arquivo à tarefa (validado no token e no confirm). */
export function attachmentPrefix(taskId: string): string {
  return `t/${taskId}/`;
}

/** Nome de exibição seguro: só o basename, sem controle e caracteres inválidos, limitado.
 *  (mantém letras/acentos/dígitos/espaço/ponto/hífen — remove só controle 0x00–0x1F e o perigoso). */
function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "arquivo";
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\x00-\x1f<>:"/\\|?*]/g, "").trim().slice(0, 200) || "arquivo";
}

/** Slug ASCII seguro pro PATHNAME do blob (o nome exibível vai separado). Só [A-Za-z0-9._-]. */
function pathSafeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "arquivo";
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "arquivo";
}

export class AttachmentService {
  constructor(private readonly repo: AttachmentRepo) {}

  /**
   * Gera uma URL de PUT ASSINADA de curta duração pro browser subir DIRETO pro Blob (privado).
   * O pathname é gerado no SERVIDOR (com componente aleatório) — o client não propõe caminho. Tipo/tamanho
   * viram constraints assinadas no token (o Blob rejeita o que fugir); o registro real é feito no confirm. [anexos B]
   */
  async requestUpload(
    task: TaskRecord,
    fileName: string,
    contentType: string,
    size: number,
  ): Promise<{ uploadUrl: string; pathname: string }> {
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new AppError("VALIDACAO", "Tipo de arquivo não permitido (só imagem, PDF ou ZIP)");
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_SIZE_BYTES) {
      throw new AppError("VALIDACAO", "Arquivo fora do tamanho permitido (até 15 MB)");
    }
    // aleatório do servidor + slug → inguessável e sem colisão; addRandomSuffix:false → o pathname final é ESTE
    const pathname = `${attachmentPrefix(task.id)}${randomUUID()}-${pathSafeName(fileName)}`;
    const token = await issueSignedToken({
      pathname,
      operations: ["put"],
      allowedContentTypes: [contentType],
      maximumSizeInBytes: MAX_SIZE_BYTES,
      validUntil: Date.now() + 15 * 60 * 1000,
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: "put",
      pathname,
      access: "private",
      allowedContentTypes: [contentType],
      maximumSizeInBytes: MAX_SIZE_BYTES,
      addRandomSuffix: false, // já embutimos o aleatório no pathname → o final é previsível pro confirm
      allowOverwrite: false,
      validUntil: Date.now() + 10 * 60 * 1000, // a URL de PUT em si dura só 10 min
    });
    return { uploadUrl: presignedUrl, pathname };
  }

  /**
   * Confirma um upload já feito no Blob: valida o pathname (prefixo da tarefa) e o metadata REAL
   * (`head()` — tamanho/tipo não confiáveis vindos do client), então grava. Idempotente por pathname.
   */
  async confirm(
    session: SessionContext,
    task: TaskRecord,
    url: string,
    pathname: string,
    fileName: string,
  ): Promise<AttachmentItem> {
    const prefix = attachmentPrefix(task.id);
    if (!pathname.startsWith(prefix)) throw new AppError("VALIDACAO", "Anexo inválido para esta tarefa");

    let meta: { size: number; contentType?: string; pathname: string };
    try {
      meta = await head(url);
    } catch {
      throw new AppError("VALIDACAO", "Arquivo não encontrado no armazenamento");
    }
    // o blob tem que ser exatamente o pathname reivindicado (e sob o prefixo da tarefa)
    if (meta.pathname !== pathname || !meta.pathname.startsWith(prefix)) {
      throw new AppError("VALIDACAO", "Anexo inválido para esta tarefa");
    }
    const contentType = meta.contentType ?? "application/octet-stream";
    if (meta.size > MAX_SIZE_BYTES || !ALLOWED_CONTENT_TYPES.includes(contentType)) {
      await del(url).catch(() => {}); // limpa o blob rejeitado
      throw new AppError("VALIDACAO", "Arquivo não permitido (tipo ou tamanho)");
    }

    // idempotência: se já registrado (double-POST), devolve o existente
    const existing = await this.repo.findByPathname(pathname, task.orgId);
    if (existing) return this.toItem(existing, session, true);
    try {
      const row = await this.repo.create({
        taskId: task.id,
        orgId: task.orgId,
        uploaderId: session.userId,
        fileName: sanitizeFileName(fileName),
        contentType,
        size: meta.size,
        url,
        pathname,
      });
      return this.toItem(row, session, true);
    } catch (e) {
      // corrida de double-POST: o unique(pathname) barrou o 2º create → devolve o que ganhou
      const again = await this.repo.findByPathname(pathname, task.orgId);
      if (again) return this.toItem(again, session, true);
      throw e;
    }
  }

  /** URL de download ASSINADA (get, ~5 min) pro anexo — só depois do gate de acesso na rota. [anexos B] */
  async signDownload(task: TaskRecord, attachmentId: string): Promise<string> {
    const row = await this.repo.findById(attachmentId, task.orgId);
    if (!row || row.taskId !== task.id) throw new AppError("NAO_ENCONTRADO", "Anexo não encontrado");
    const token = await issueSignedToken({
      pathname: row.pathname,
      operations: ["get"],
      validUntil: Date.now() + 10 * 60 * 1000,
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: "get",
      pathname: row.pathname,
      access: "private",
      validUntil: Date.now() + 5 * 60 * 1000, // o link em si expira em 5 min
    });
    return presignedUrl;
  }

  async list(session: SessionContext, task: TaskRecord, canModerate: boolean): Promise<AttachmentItem[]> {
    const rows = await this.repo.listByTask(task.id, task.orgId);
    return rows.map((r) => this.toItem(r, session, canModerate));
  }

  /** Remover: uploader OU moderador. Linha primeiro (corta o acesso), blob depois (best-effort). */
  async remove(session: SessionContext, task: TaskRecord, attachmentId: string, canModerate: boolean): Promise<void> {
    const row = await this.repo.findById(attachmentId, task.orgId);
    if (!row || row.taskId !== task.id) throw new AppError("NAO_ENCONTRADO", "Anexo não encontrado");
    if (row.uploaderId !== session.userId && !canModerate) {
      throw new AppError("SEM_PERMISSAO", "Você não pode remover este anexo");
    }
    await this.repo.delete(row.id, task.orgId);
    await del(row.url).catch(() => {}); // órfão de blob é o mal menor (invisível ao app)
  }

  private toItem(
    r: { id: string; taskId: string; fileName: string; contentType: string; size: number; uploaderId: string; uploaderName: string; createdAt: Date },
    session: SessionContext,
    canModerate: boolean,
  ): AttachmentItem {
    // A URL crua do blob (privada) NÃO vai pro DTO — o download passa pelo endpoint que assina. [anexos B]
    return {
      id: r.id,
      taskId: r.taskId,
      fileName: r.fileName,
      contentType: r.contentType,
      size: r.size,
      uploaderName: r.uploaderName,
      createdAt: r.createdAt.toISOString(),
      canRemove: r.uploaderId === session.userId || canModerate,
    };
  }
}
