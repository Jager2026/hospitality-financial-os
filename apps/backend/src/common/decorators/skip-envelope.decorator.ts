import { SetMetadata } from "@nestjs/common";

export const SKIP_ENVELOPE_KEY = "skipEnvelope";

/** Opt out of ResponseInterceptor's {success,data,meta} wrapping — e.g. health checks, which
 * have their own shape and are consumed by infra, not by API_Contract.md's client contract. */
export const SkipEnvelope = () => SetMetadata(SKIP_ENVELOPE_KEY, true);
