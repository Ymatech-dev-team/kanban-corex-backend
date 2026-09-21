import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { put, del } from "@vercel/blob";
import { AppError } from "../../lib/errors.js";
import type { UserRepo } from "../auth/types.js";

/**
 * Foto de perfil (avatar). O binário vai num store Vercel Blob PÚBLICO (aparece pra outros membros → URL
 * direta, sem assinar). Como é público, o backend NUNCA grava os bytes crus do client: valida o formato
 * REAL pelos bytes e RE-ENCODA com sharp (JPEG canônico) — isso mata polyglot/SVG-com-script/bomb e tira
 * EXIF/GPS. O resize no client é só economia de banda, não fronteira de confiança. [conta-redesign]
 */
const AVATAR_SIZE = 512;
const MAX_BASE64_CHARS = 1_500_000; // ~1.1 MB decodificado — cap ANTES do decode (anti-DoS de memória)
const ALLOWED_INPUT = new Set(["jpeg", "png", "webp"]); // formato REAL lido pelo sharp; svg fica de fora
// teto de pixels EXPLÍCITO (não depende do default do sharp) — mata decompression bomb no decode.
const SHARP_OPTS = { limitInputPixels: 24_000_000 } as const;

type Logger = { warn: (obj: unknown, msg: string) => void };

export class ProfileService {
  constructor(
    private readonly users: UserRepo,
    private readonly blobToken: string, // BLOB_PUBLIC_READ_WRITE_TOKEN (store PÚBLICO)
  ) {}

  async setAvatar(userId: string, imageBase64: string, log?: Logger): Promise<{ avatarUrl: string }> {
    // aceita data-URL ("data:image/...;base64,XXXX") ou base64 puro
    const raw = imageBase64.includes(",") ? imageBase64.slice(imageBase64.indexOf(",") + 1) : imageBase64;
    // 1) CAP antes de decodar — um base64 gigante nunca vira Buffer na memória da function
    if (raw.length === 0 || raw.length > MAX_BASE64_CHARS) {
      throw new AppError("VALIDACAO", "Imagem inválida ou muito grande (máx. ~1 MB)");
    }
    const input = Buffer.from(raw, "base64");
    if (input.length === 0) throw new AppError("VALIDACAO", "Imagem inválida");

    // 2) formato REAL pelos bytes (ignora o content-type do client); svg explicitamente fora.
    //    `metadata()` só lê o cabeçalho — não rasteriza (svg cai fora ANTES de qualquer render).
    let format: string | undefined;
    try {
      format = (await sharp(input, SHARP_OPTS).metadata()).format;
    } catch {
      throw new AppError("VALIDACAO", "Arquivo não é uma imagem válida");
    }
    if (!format || !ALLOWED_INPUT.has(format)) {
      throw new AppError("VALIDACAO", "Use uma imagem PNG, JPG ou WebP");
    }

    // 3) re-encoda: quadrado 512, JPEG limpo. `.rotate()` aplica a orientação do EXIF e o sharp DESCARTA o
    //    metadata na saída (sem GPS). Gravamos a SAÍDA DO SERVIDOR, nunca o buffer do client. O decode real
    //    dos pixels acontece aqui → try/catch pra header-válido-corpo-corrompido virar 400, não 500.
    let output: Buffer;
    try {
      output = await sharp(input, SHARP_OPTS)
        .rotate()
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer();
    } catch {
      throw new AppError("VALIDACAO", "Não foi possível processar a imagem");
    }

    // 4) grava no store público, path randômico (sem userId cru na URL)
    const { url } = await put(`avatars/${randomUUID()}.jpg`, output, {
      access: "public",
      token: this.blobToken,
      contentType: "image/jpeg",
      addRandomSuffix: false,
    });

    // 5) ordem segura: coluna aponta pro novo ANTES de apagar o antigo
    const before = await this.users.findById(userId);
    try {
      await this.users.updateAvatar(userId, url);
    } catch (e) {
      await del(url, { token: this.blobToken }).catch(() => {}); // update falhou → não deixa órfão do novo
      throw e;
    }
    if (before?.avatarUrl && before.avatarUrl !== url) {
      await del(before.avatarUrl, { token: this.blobToken }).catch((e) => this.logDelFail(before.avatarUrl!, e, log));
    }
    return { avatarUrl: url };
  }

  async removeAvatar(userId: string, log?: Logger): Promise<void> {
    const before = await this.users.findById(userId);
    await this.users.updateAvatar(userId, null); // corta o acesso primeiro (coluna)
    if (before?.avatarUrl) {
      // apaga o blob DE FATO (privacidade). Se falhar, LOGA — a foto seguiria pública sem ninguém saber.
      await del(before.avatarUrl, { token: this.blobToken }).catch((e) => this.logDelFail(before.avatarUrl!, e, log));
    }
  }

  private logDelFail(url: string, e: unknown, log?: Logger): void {
    log?.warn({ event: "avatar_blob_del_failed", url, err: e instanceof Error ? e.message : String(e) }, "falha ao apagar blob de avatar (reconciliação manual)");
  }
}
