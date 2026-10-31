import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthGuard } from '../auth/auth.guard';

export const storeRoom = (tenantId: string, storeId: string) => `t:${tenantId}:s:${storeId}`;
export const tenantRoom = (tenantId: string) => `t:${tenantId}`;

/**
 * WebSocket-Endpunkt für Live-Bestand.
 * Der Client übergibt beim Verbinden sein Access-Token (handshake.auth.token).
 * Er wird ausschließlich den Räumen seiner Filialen zugeordnet – ein Socket kann
 * Events anderer Mandanten oder Filialen nie empfangen.
 */
@WebSocketGateway({ namespace: '/live', cors: { origin: process.env.CORS_ORIGIN ?? false } })
export class StockGateway implements OnGatewayConnection {
  private readonly log = new Logger(StockGateway.name);
  @WebSocketServer() server!: Server;

  constructor(private readonly auth: AuthGuard) {}

  async handleConnection(socket: Socket) {
    try {
      const token = String(socket.handshake.auth?.token ?? '');
      const ctx = await this.auth.buildContext(await this.auth.verify(token));
      socket.data.ctx = ctx;
      if (ctx.role === 'owner') {
        await socket.join(tenantRoom(ctx.tenantId));            // Inhaber: alle Filialen
      } else {
        await socket.join(ctx.storeIds.map((s) => storeRoom(ctx.tenantId, s)));
      }
    } catch {
      socket.emit('error', { message: 'Nicht autorisiert' });
      socket.disconnect(true);
    }
  }

  /** Vom Outbox-Worker aufgerufen. */
  publish(tenantId: string, storeId: string | null, topic: string, payload: unknown) {
    const rooms = storeId ? [storeRoom(tenantId, storeId), tenantRoom(tenantId)] : [tenantRoom(tenantId)];
    this.server.to(rooms).emit(topic, { storeId, ...(payload as object) });
    this.log.debug(`${topic} -> ${rooms.join(', ')}`);
  }
}
