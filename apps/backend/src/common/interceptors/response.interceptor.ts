import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, map } from "rxjs";
import { SKIP_ENVELOPE_KEY } from "../decorators/skip-envelope.decorator";

interface Envelope<T> {
  success: true;
  data: T;
  meta: Record<string, unknown>;
}

// API_Contract.md, Standard Response: { "success": true, "data": {}, "meta": {} }
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, Envelope<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<Envelope<T> | T> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    return next.handle().pipe(map((data) => ({ success: true as const, data, meta: {} })));
  }
}
