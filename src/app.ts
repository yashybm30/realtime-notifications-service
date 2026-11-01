import {
  Body,
  Controller,
  Get,
  HttpException,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import { randomUUID } from "node:crypto";
import { Realtime, roomFor } from "./realtime";
import { AuthGuard, AuthRequest, admin } from "./security";
class Send {
  @IsUUID() userId!: string;
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsString() @MaxLength(2000) body!: string;
}
@Controller("v1/notifications")
@UseGuards(AuthGuard)
class Api {
  constructor(private readonly realtime: Realtime) {}
  @Post() async send(@Body() body: Send, @Req() req: AuthRequest) {
    admin(req.actor);
    const count = Number(
      await this.realtime.redis.eval(
        "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n",
        1,
        `notify-rate:${req.actor.sub}`,
      ),
    );
    if (count > 60) throw new HttpException("Too many notifications", 429);
    const note = {
      id: randomUUID(),
      title: body.title,
      body: body.body,
      read: false,
      createdAt: new Date().toISOString(),
    };
    const key = `inbox:${req.actor.tenantId}:${body.userId}`;
    await this.realtime.redis.eval(
      "redis.call('HSET',KEYS[2],ARGV[1],ARGV[2]);redis.call('ZADD',KEYS[1],ARGV[3],ARGV[1]);local old=redis.call('ZRANGE',KEYS[1],0,-1001);for _,id in ipairs(old) do redis.call('ZREM',KEYS[1],id);redis.call('HDEL',KEYS[2],id) end;redis.call('EXPIRE',KEYS[1],2592000);redis.call('EXPIRE',KEYS[2],2592000);return 1",
      2,
      key,
      `${key}:items`,
      note.id,
      JSON.stringify(note),
      Date.now(),
    );
    this.realtime.io
      .to(roomFor(req.actor, body.userId))
      .emit("notification", note);
    return note;
  }
  @Get() async list(@Req() req: AuthRequest) {
    const key = `inbox:${req.actor.tenantId}:${req.actor.sub}`;
    const ids = await this.realtime.redis.zrevrange(key, 0, 99);
    if (!ids.length) return [];
    return (await this.realtime.redis.hmget(`${key}:items`, ...ids))
      .filter((v): v is string => v !== null)
      .map((v) => JSON.parse(v) as unknown);
  }
  @Patch(":id/read") async read(
    @Param("id") id: string,
    @Req() req: AuthRequest,
  ) {
    const key = `inbox:${req.actor.tenantId}:${req.actor.sub}:items`;
    const result = await this.realtime.redis.eval(
      "local raw=redis.call('HGET',KEYS[1],ARGV[1]);if not raw then return 0 end;local value=cjson.decode(raw);value.read=true;redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(value));return 1",
      1,
      key,
      id,
    );
    if (!result) throw new NotFoundException();
    return { read: true };
  }
}
@Controller("health")
class Health {
  constructor(private readonly realtime: Realtime) {}
  @Get("live") live() {
    return { status: "alive" };
  }
  @Get("ready") async ready() {
    await this.realtime.redis.ping();
    return { status: "ready" };
  }
}
@Module({ controllers: [Api, Health], providers: [Realtime, AuthGuard] })
export class AppModule {}
