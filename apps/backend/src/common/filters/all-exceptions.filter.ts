import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { PinoLogger } from "nestjs-pino";
import { AppException, ErrorCode } from "../exceptions/app.exception";

interface ErrorBody {
  success: false;
  error: { code: ErrorCode; message: string };
}

// API_Contract.md, Standard Response:
//   { "success": false, "error": { "code": "PAYMENT_FAILED", "message": "..." } }
// Users receive friendly messages; developers receive full diagnostics via the logger, never in
// the response body (CLAUDE.md, Error Philosophy — "never expose internal implementation").
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof AppException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as { code: ErrorCode; message: string };
      response.status(status).json({ success: false, error: body } satisfies ErrorBody);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const message = this.extractMessage(exception);
      response.status(status).json({
        success: false,
        error: { code: this.codeForStatus(status), message },
      } satisfies ErrorBody);
      return;
    }

    // Unknown/unhandled — full detail goes to the logger only, never to the client.
    this.logger.error({ err: exception }, "Unhandled exception");
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: { code: "UNKNOWN_ERROR", message: "Something went wrong. Please try again." },
    } satisfies ErrorBody);
  }

  private extractMessage(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === "string") return response;
    if (typeof response === "object" && response !== null && "message" in response) {
      const msg = (response as { message: unknown }).message;
      return Array.isArray(msg) ? msg.join(", ") : String(msg);
    }
    return exception.message;
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return "VALIDATION_ERROR";
      case HttpStatus.UNAUTHORIZED:
        return "AUTH_INVALID";
      case HttpStatus.FORBIDDEN:
        return "PERMISSION_DENIED";
      case HttpStatus.NOT_FOUND:
        return "NOT_FOUND";
      case HttpStatus.CONFLICT:
        return "IDEMPOTENCY_KEY_CONFLICT";
      default:
        return "UNKNOWN_ERROR";
    }
  }
}
