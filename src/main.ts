import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';

declare const module: any;

type GlobalState = {
  __nestApp__?: INestApplication;
  __signalsRegistered__?: boolean;
};

const globalState = globalThis as typeof globalThis & GlobalState;

async function closeExistingApp(signal?: string) {
  const existingApp = globalState.__nestApp__;
  if (!existingApp) {
    return;
  }

  try {
    if (signal) {
      console.log(`${signal} received. Closing Nest app...`);
    }
    await existingApp.close();
  } catch (error) {
    console.error('Error while closing Nest app', error);
  } finally {
    globalState.__nestApp__ = undefined;
  }
}

function registerSignalHandlers() {
  if (globalState.__signalsRegistered__) {
    return;
  }

  ['SIGINT', 'SIGTERM', 'SIGUSR2'].forEach((signal) => {
    process.on(signal, () => {
      void (async () => {
        await closeExistingApp(signal);
        process.exit(0);
      })();
    });
  });

  globalState.__signalsRegistered__ = true;
}

async function bootstrap() {
  registerSignalHandlers();

  await closeExistingApp();

  const app = await NestFactory.create(AppModule);
  globalState.__nestApp__ = app;

  app.enableShutdownHooks();
  app.setGlobalPrefix('v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Activity Tracker API')
    .setDescription('Employee activity tracking service')
    .setVersion('1.0.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    })
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument);

  const port = process.env.PORT ? Number(process.env.PORT) : 9900;
  console.log(`Server starting at port: ${port}`);

  await app.listen(port);

  if (module?.hot) {
    module.hot.accept();
    module.hot.dispose(() => app.close());
  }
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('Failed to bootstrap Nest app', error);
    process.exit(1);
  });
}

export { bootstrap };
