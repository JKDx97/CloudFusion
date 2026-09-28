# CloudFusion

CloudFusion es un gestor multicloud construido sobre Angular, NestJS, TypeScript, PostgreSQL y TypeORM. La Fase 2 conecta Google Drive y OneDrive mediante OAuth 2.0 y ofrece un explorador unificado sin almacenar los archivos en CloudFusion.

## Stack

- Frontend: Angular, TypeScript, Tailwind CSS y RxJS.
- Backend: NestJS, REST, Swagger, TypeORM y PostgreSQL.
- Seguridad: JWT access/refresh, Argon2, AES-256-GCM para tokens cloud, Helmet, CORS, validación y rate limiting.
- Proveedores implementados: Google Drive y Microsoft OneDrive.
- Redis: preparado para OAuth state y cache futura; el estado OAuth actual tiene TTL en memoria para desarrollo local.

## Instalación

```powershell
Copy-Item .env.example .env
npm --prefix apps/api install
npm --prefix apps/web install
```

Completa las variables de OAuth antes de conectar una cuenta. Nunca guardes secretos reales en Git.

## Variables de entorno

Además de las variables existentes de Fase 1, configura:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/cloud-accounts/google/callback

MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_REDIRECT_URI=http://localhost:3000/cloud-accounts/onedrive/callback
MICROSOFT_TENANT_ID=common

# 32 bytes en base64 o 64 caracteres hexadecimales
CLOUD_TOKEN_ENCRYPTION_KEY=
CLOUD_UPLOAD_MAX_BYTES=52428800
CLOUD_OAUTH_STATE_TTL_SECONDS=600
```

Genera una clave de cifrado segura, por ejemplo:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Google Cloud Console

1. Crea o selecciona un proyecto en Google Cloud Console.
2. Habilita la API de Google Drive.
3. Configura la pantalla de consentimiento OAuth y añade los usuarios de prueba.
4. Crea un cliente OAuth de tipo aplicación web.
5. Añade `http://localhost:3000/cloud-accounts/google/callback` como URI de redirección autorizado.
6. Copia el client ID y el client secret al `.env`.

CloudFusion solicita `openid`, `email`, `profile` y `https://www.googleapis.com/auth/drive` porque la Fase 2 debe listar, crear, subir, renombrar, descargar y eliminar elementos.

## Microsoft Entra / Graph

1. Registra una aplicación en Microsoft Entra ID.
2. Añade `http://localhost:3000/cloud-accounts/onedrive/callback` como redirect URI web.
3. Crea un client secret para desarrollo.
4. En Microsoft Graph, concede permisos delegados `User.Read`, `Files.ReadWrite` y `offline_access`.
5. Usa `common` en `MICROSOFT_TENANT_ID` para permitir cuentas Microsoft personales y organizacionales, según la configuración de la aplicación.
6. Copia el client ID, client secret y tenant al `.env`.

## Arquitectura de proveedores

```text
Angular
   │
   ▼
CloudFusion REST API
   │
   ▼
CloudProviderResolver / CloudAccountService
   │
   ├── GoogleDriveAdapter ── Google Drive API
   │
   └── OneDriveAdapter ───── Microsoft Graph
```

Los controllers trabajan con servicios internos y el frontend usa el modelo `CloudFile` común. Cada elemento conserva `provider`, `accountId` y `fileId` remoto.

## Desarrollo

```powershell
docker compose up -d
npm --prefix apps/api run migration:run
npm --prefix apps/api run start:dev
npm --prefix apps/web start
```

La API queda en `http://localhost:3000`, Swagger en `http://localhost:3000/api/docs` y Angular en `http://localhost:4200`.

## Fase 2

- Google Drive y OneDrive con OAuth 2.0 Authorization Code Flow.
- Cuentas cloud por usuario con múltiples cuentas permitidas por proveedor.
- Tokens cloud cifrados con AES-256-GCM y renovación automática.
- Explorador multicloud con carpetas, breadcrumbs y vista unificada.
- Upload por archivo temporal en disco, descarga por streaming, renombrado y eliminación.
- Cuotas por cuenta y resumen de almacenamiento combinado.
- Errores de proveedores normalizados y ownership comprobado en cada endpoint.

### Endpoints principales

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/cloud-accounts` | Cuentas conectadas del usuario |
| GET | `/cloud-accounts/storage-summary` | Cuotas y total combinado |
| GET | `/cloud-accounts/google/connect` | Iniciar OAuth Google |
| GET | `/cloud-accounts/google/callback` | Callback Google |
| GET | `/cloud-accounts/onedrive/connect` | Iniciar OAuth Microsoft |
| GET | `/cloud-accounts/onedrive/callback` | Callback Microsoft |
| POST | `/cloud-accounts/:id/refresh` | Renovar token/cuota |
| DELETE | `/cloud-accounts/:id` | Desconectar cuenta |
| GET | `/cloud-files?accountId=&parentId=` | Listar carpeta o todas las cuentas |
| POST | `/cloud-files/:accountId/upload` | Subir archivo multipart |
| POST | `/cloud-files/:accountId/folders` | Crear carpeta |
| GET | `/cloud-files/:accountId/:fileId/download` | Descargar por streaming |
| PATCH | `/cloud-files/:accountId/:fileId` | Renombrar |
| DELETE | `/cloud-files/:accountId/:fileId` | Eliminar |

Todos los endpoints de cuentas y archivos, salvo callbacks OAuth, requieren el JWT existente de Fase 1. Los callbacks nunca devuelven tokens al navegador.

## Verificación

```powershell
npm --prefix apps/api test
npm --prefix apps/api run build
npm --prefix apps/web test -- --watch=false
npm --prefix apps/web run build
```

Las pruebas unitarias mockean proveedores externos y cubren cifrado, ownership de cuentas y rechazo de accesos cruzados. Para una prueba real de Google u OneDrive se necesitan credenciales OAuth configuradas y una cuenta autorizada.

## Fuera de la Fase 2

CloudFusion todavía no implementa almacenamiento propio, sincronización entre nubes, transferencias cloud-to-cloud, Dropbox, Box, MEGA, pCloud, P2P, BitTorrent, chunking distribuido, deduplicación, CDN, Kubernetes, aplicación móvil, WebDAV ni gateway S3.
