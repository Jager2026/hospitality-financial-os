// Every existing test constructed services by hand (`new AuthService(fakePrisma, ...)`),
// bypassing NestJS's decorator-based DI entirely — so nothing surfaced that vitest's test
// environment never loads this, unlike main.ts. The first test to build a real
// Test.createTestingModule() (auth-throttle.integration.spec.ts) fails silently without it:
// constructor injection resolves to `undefined` instead of throwing, because
// Reflect.getMetadata("design:paramtypes", ...) has nothing to read.
import "reflect-metadata";

// Same class of gap as reflect-metadata above, found the same way — by a test that finally
// exercised the thing: main.ts imports this polyfill, vitest's environment never did, and no test
// had yet hit an endpoint returning a raw Prisma `bigint`. Every money-bearing read endpoint does
// (Payment.amount / tipAmount are BIGINT minor units, ADR-001), so GET /payments/:id threw
// "TypeError: Do not know how to serialize a BigInt" under test while working correctly in
// production — a test environment diverging from production, not a real defect. Loading it here
// makes the two agree, so a genuine BigInt serialization regression would fail a test rather than
// only ever showing up live.
import "../src/common/bigint-json.polyfill";
