import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: true });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.enableShutdownHooks();
  // Auf dem Kundenserver hinter Caddy/Traefik mit TLS; die API selbst lauscht nur intern.
  await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1');
}

void bootstrap();
