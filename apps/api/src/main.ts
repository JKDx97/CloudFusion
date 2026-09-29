import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import type { CustomOrigin } from '@nestjs/common/interfaces/external/cors-options.interface';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './common/filters/http-error.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const port = config.get<number>('api.port') ?? 3000;
  const frontendUrl =
    config.get<string>('app.frontendUrl') ?? 'http://localhost:4200';
  const allowedFrontendOrigins = new Set(
    frontendUrl.split(',').map((origin) => origin.trim()).filter(Boolean),
  );
  // Tauri's production origin is http://tauri.localhost on Windows and
  // tauri://localhost on macOS/Linux. Keep browser origins explicitly scoped.
  allowedFrontendOrigins.add('http://tauri.localhost');
  allowedFrontendOrigins.add('tauri://localhost');
  const validateFrontendOrigin: CustomOrigin = (origin, callback) => {
    if (!origin || allowedFrontendOrigins.has(origin)) callback(null, true);
    else callback(null, false);
  };
  const trustProxy = config.get<boolean | number | string>('app.trustProxy') ?? false;

  if (trustProxy) app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
  app.use(helmet());
  app.enableCors({
    origin: validateFrontendOrigin,
    credentials: true,
    preflightContinue: true,
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'OPTIONS' && request.header('access-control-request-method')) {
      response.status(204).end();
      return;
    }
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpErrorFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('CloudFusion API')
    .setDescription('API de identidad, proveedores cloud y CloudFusion Drive')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  await app.listen(port);
  new Logger('Bootstrap').log(
    JSON.stringify({ event: 'application.started', port }),
  );
}
void bootstrap();
