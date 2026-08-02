import { PipeTransform, Injectable, ArgumentMetadata } from "@nestjs/common";
import { ZodError, ZodSchema } from "zod";
import { AppException } from "../exceptions/app.exception";

// MASTERPLAN.md's stack calls for Zod validation on both frontend and backend. Usage:
//   @Body(new ZodValidationPipe(createRestaurantSchema)) body: CreateRestaurantDto
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const message = this.formatError(result.error);
      throw new AppException("VALIDATION_ERROR", message, 400);
    }
    return result.data;
  }

  private formatError(error: ZodError): string {
    return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  }
}
