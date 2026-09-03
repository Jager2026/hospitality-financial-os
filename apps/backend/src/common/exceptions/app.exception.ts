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
  | "INVITATION_INVALID"
  | "PAYMENT_NOT_FOUND"
  | "RESTAURANT_NOT_FOUND"
  | "ORGANIZATION_NOT_FOUND"
  | "WALLET_NOT_FOUND"
  | "WITHDRAWAL_NOT_AVAILABLE"
  // ADR-062: a refund larger than the bill has no balanced Ledger entry under the rule that the
  // tip is never reversed. Raised inside the webhook handler, before any write, so the event is
  // retried and alerted rather than booked wrong. Not a client-facing code.
  | "REFUND_EXCEEDS_BILL"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "PERMISSION_DENIED"
  | "PASSWORD_BREACHED"
  // ADR-049. Its own code rather than a second VALIDATION_ERROR, because registration now has two
  // different 409s and the screen has to tell them apart: an email already in use must stay vague
  // (enumeration), while a stale terms version needs the opposite — "reload and read them again".
  // One code for both would force the UI to guess from the message text, which is the one part of
  // the envelope this contract says may be translated.
  | "TERMS_VERSION_MISMATCH"
  // ADR-055. 503, not a 4xx: nothing about the request is wrong. The service cannot honestly
  // accept a registration while its own terms are unpublished, and that is a server-side state
  // the caller can do nothing about.
  | "REGISTRATION_UNAVAILABLE"
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
