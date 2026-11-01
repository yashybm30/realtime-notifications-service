import "reflect-metadata";
import { beforeAll, afterAll, test, expect } from "vitest";
import { NestFactory } from "@nestjs/core";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
const require = createRequire(import.meta.url);
const { AppModule } = require("../dist/app");
const { configure } = require("../dist/platform");
const tenant = randomUUID(),
  otherTenant = randomUUID(),
  owner = randomUUID(),
  member = randomUUID();
function token(sub = owner, tenantId = tenant, role = "admin") {
  return jwt.sign({ sub, tenantId, role }, process.env.JWT_SECRET!, {
    issuer: "portfolio-auth",
    audience: "portfolio-api",
    expiresIn: 300,
  });
}
let app: Awaited<ReturnType<typeof NestFactory.create>>;
let api: ReturnType<typeof request>;
beforeAll(async () => {
  process.env.JWT_SECRET = "integration-only-signing-key-".repeat(3);
  process.env.PLATFORM_ADMIN_SUB = owner;
  app = await NestFactory.create(AppModule, { logger: false });
  configure(app);
  await app.listen(0, "127.0.0.1");
  api = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});
test("cross-instance notification fanout and durable inboxes remain user-scoped", async () => {
  const { io } = await import("socket.io-client");
  const secondary = await NestFactory.create(AppModule, { logger: false });
  configure(secondary);
  await secondary.listen(0, "127.0.0.1");
  const address = secondary.getHttpServer().address();
  const url = `http://127.0.0.1:${address.port}`;
  const receiver = io(url, {
    auth: { token: token(member, tenant, "member") },
    transports: ["websocket"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      receiver.once("connect", resolve);
      receiver.once("connect_error", reject);
    });
    const delivered = new Promise<{ id: string }>((resolve) =>
      receiver.once("notification", resolve),
    );
    const sent = await api
      .post("/v1/notifications")
      .set("Authorization", `Bearer ${token()}`)
      .send({ userId: member, title: "Hello", body: "Durable inbox" })
      .expect(201);
    expect((await delivered).id).toBe(sent.body.id);
    const recipient = {
      Authorization: `Bearer ${token(member, tenant, "member")}`,
    };
    expect(
      (await api.get("/v1/notifications").set(recipient)).body.some(
        (n: { id: string }) => n.id === sent.body.id,
      ),
    ).toBe(true);
    await api
      .patch(`/v1/notifications/${sent.body.id}/read`)
      .set("Authorization", `Bearer ${token(randomUUID(), otherTenant)}`)
      .expect(404);
    await api
      .patch(`/v1/notifications/${sent.body.id}/read`)
      .set(recipient)
      .expect(200);
    await api
      .post("/v1/notifications")
      .set(recipient)
      .send({ userId: owner, title: "Denied", body: "" })
      .expect(403);
  } finally {
    receiver.close();
    await secondary.close();
  }
});
