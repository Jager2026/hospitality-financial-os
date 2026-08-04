// Every existing test constructed services by hand (`new AuthService(fakePrisma, ...)`),
// bypassing NestJS's decorator-based DI entirely — so nothing surfaced that vitest's test
// environment never loads this, unlike main.ts. The first test to build a real
// Test.createTestingModule() (auth-throttle.integration.spec.ts) fails silently without it:
// constructor injection resolves to `undefined` instead of throwing, because
// Reflect.getMetadata("design:paramtypes", ...) has nothing to read.
import "reflect-metadata";
