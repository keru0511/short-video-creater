export class UserError extends Error {
  code: string;
  userMessage: string;

  constructor(code: string, message: string, userMessage: string) {
    super(message);
    this.name = 'UserError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

export function toUserMessage(err: unknown): string {
  if (err instanceof UserError) {
    return err.userMessage;
  }

  if (err instanceof Error) {
    // 既に日本語のメッセージはそのまま返す
    if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(err.message)) {
      return err.message;
    }
    return `エラー: ${err.message}`;
  }

  return `エラー: ${String(err)}`;
}
