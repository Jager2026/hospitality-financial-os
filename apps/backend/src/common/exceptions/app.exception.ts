import { HttpException, HttpStatus } from "@nestjs/common";

// The fixed vocabulary from API_Contract.md's Error Codes section. "Codes never change.
// Messages may be translated" — ADR-013 routes `message` through i18n later; `code` never does.
export type ErrorCode =
  | "AUTH_INVALID"
  | "AUTH_EXPIRED"
  | "PAYMENT_FAILED"
  | "PAYMENT_DECLINED"
  | "INVALID_TIP"
  | "MEMBERSHIP_NOT_FOUND"
  | "RESTAURANT_NOT_FOUND"
  | "ORGANIZATION_NOT_FOUND"
  | "WALLET_NOT_FOUND"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "PERMISSION_DENIED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "UNKNOWN_ERROR";

/** Business/domain exceptions should throw this, not a bare NestJS HttpException, so the
 * response body always matches API_Contract.md's error envelope. */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super({ code, message }, status);
  }
}
