# CloudFusion

CloudFusion es la base de una plataforma de almacenamiento multicloud. Esta primera fase entrega la identidad de usuarios, autenticación segura, una API REST documentada y una interfaz web protegida. Las integraciones de proveedores cloud, transferencia P2P y almacenamiento distribuido quedan fuera de esta fase.

## Stack

- Frontend: Angular, TypeScript, Tailwind CSS y RxJS.
- Backend: NestJS, TypeScript, REST, Swagger y TypeORM.
- Persistencia: PostgreSQL.
- Infraestructura preparada: Redis mediante Docker Compose.
- Seguridad: JWT de acceso y refresh, Argon2, Helmet, CORS, validación y rate limiting.

## Requisitos

- Node.js 22 o superior y npm.
- Docker Desktop con Compose para PostgreSQL y Redis.
- Git.

## Estructura

```text
CloudFusion/
├── apps/
│   ├── api/   # NestJS
│   └── web/   # Angular
├── docker-compose.yml
├── .env.example
└── README.md
```

## Instalación

```powershell
git clone https://github.com/JKDx97/CloudFusion.git
cd CloudFusion
Copy-Item .env.example .env
npm --prefix apps/api install
npm --prefix apps/web install
```

Edita `.env` con valores locales. No subas este archivo ni secretos reales al repositorio.

## PostgreSQL y Redis

```powershell
docker compose up -d
```

La API usa PostgreSQL y deja Redis preparado para fases posteriores. En desarrollo, las migraciones se ejecutan con:

```powershell
npm --prefix apps/api run migration:run
```

Para revertir la última migración:

```powershell
npm --prefix apps/api run migration:revert
```

## Backend

```powershell
npm --prefix apps/api run start:dev
```

La API queda disponible en `http://localhost:3000` y Swagger en `http://localhost:3000/api/docs`.

## Frontend

```powershell
npm --prefix apps/web start
```

La interfaz queda disponible en `http://localhost:4200`. Permite registrar usuarios, iniciar sesión, renovar la sesión y acceder al dashboard protegido.

## Tests y builds

```powershell
npm --prefix apps/api test
npm --prefix apps/api run build
npm --prefix apps/web test -- --watch=false
npm --prefix apps/web run build
```

## Endpoints de autenticación

| Método | Ruta | Descripción |
| --- | --- | --- |
| POST | `/auth/register` | Registra un usuario y devuelve tokens. |
| POST | `/auth/login` | Inicia sesión. |
| POST | `/auth/refresh` | Rota el refresh token y entrega un nuevo access token. |
| POST | `/auth/logout` | Invalida la sesión actual. |
| GET | `/auth/me` | Devuelve el usuario autenticado. |

Las respuestas exitosas tienen la forma `{ data, message }`. Los errores no exponen trazas en producción.

## Fuera de la Fase 1

No se implementan todavía Google Drive, OneDrive, Dropbox, OAuth de proveedores, explorador de archivos, almacenamiento propio, chunking, compresión, cifrado de archivos, BullMQ, P2P, BitTorrent, deduplicación, CDN ni Kubernetes.
