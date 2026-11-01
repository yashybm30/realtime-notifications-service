import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Server, Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
import { Actor, identity } from "./security";
export type AuthedSocket = Socket & {
  data: { actor: Actor; expiry?: NodeJS.Timeout };
};
export const roomFor = (actor: Actor, user = actor.sub) =>
  `tenant-${actor.tenantId}-user-${user}`;
@Injectable()
export class Realtime implements OnModuleInit, OnModuleDestroy {
  readonly redis = new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: 1,
  });
  readonly sub = this.redis.duplicate();
  io!: Server;
  constructor(private readonly host: HttpAdapterHost) {
    this.redis.on("error", () => undefined);
    this.sub.on("error", () => undefined);
  }
  async onModuleInit() {
    this.io = new Server(this.host.httpAdapter.getHttpServer(), {
      cors: { origin: process.env.CORS_ORIGIN?.split(",") ?? [] },
      maxHttpBufferSize: 32768,
    });
    this.io.adapter(createAdapter(this.redis, this.sub));
    await Promise.all([this.redis.ping(), this.sub.ping()]);
    this.io.use((socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        if (typeof token !== "string") throw new Error();
        socket.data.actor = identity(token);
        const exp = (jwt.decode(token) as { exp?: number }).exp;
        if (!exp) throw new Error();
        socket.data.expiry = setTimeout(
          () => socket.disconnect(true),
          Math.max(0, exp * 1000 - Date.now()),
        );
        next();
      } catch {
        next(new Error("Unauthorized"));
      }
    });
    this.io.on("connection", (socket: AuthedSocket) => {
      void socket.join(roomFor(socket.data.actor));
      socket.on("disconnect", () => {
        if (socket.data.expiry) clearTimeout(socket.data.expiry);
      });
    });
  }
  async onModuleDestroy() {
    await new Promise<void>((resolve) =>
      this.io ? this.io.close(() => resolve()) : resolve(),
    );
    this.redis.disconnect();
    this.sub.disconnect();
  }
}
