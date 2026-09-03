/** Erro de aplicação com código estável e status HTTP. Contrato uniforme: {error:{code,message}}. */

export type ErrorCode =
  | "VALIDACAO"
  | "NAO_AUTENTICADO"
  | "SEM_PERMISSAO"
  | "NAO_ENCONTRADO"
  | "CONFLITO"
  | "MUITAS_TENTATIVAS"
  | "PROJETO_SEM_ACESSO"
  | "TAREFA_REMOVIDA"
  | "TROCA_SENHA_OBRIGATORIA"
  | "INTERNO";

const STATUS: Record<ErrorCode, number> = {
  VALIDACAO: 400,
  NAO_AUTENTICADO: 401,
  SEM_PERMISSAO: 403,
  NAO_ENCONTRADO: 404,
  CONFLITO: 409,
  MUITAS_TENTATIVAS: 429,
  PROJETO_SEM_ACESSO: 403, // ejeta o board no front [JOR-1c]
  TAREFA_REMOVIDA: 404,
  TROCA_SENHA_OBRIGATORIA: 403,
  INTERNO: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = STATUS[code];
  }
}

export function errorBody(code: ErrorCode, message: string) {
  return { error: { code, message } };
}
