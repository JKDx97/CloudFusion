# CloudFusion

CloudFusion es un gestor multicloud construido sobre Angular, NestJS, TypeScript, PostgreSQL y TypeORM. Las Fases 2 y 3 conectan Google Drive y OneDrive mediante OAuth 2.0 y orquestan transferencias entre proveedores. La Fase 4 agrega CloudFusion Drive: un sistema de archivos virtual cuyo índice y organización viven en PostgreSQL, mientras el contenido físico se guarda en réplicas administradas sobre las cuentas cloud del usuario.

## Stack

- Frontend: Angular, TypeScript, Tailwind CSS y RxJS.
- Backend: NestJS, REST, Swagger, TypeORM y PostgreSQL.
- Seguridad: JWT access/refresh, Argon2, AES-256-GCM para tokens cloud, Helmet, CORS, validación y rate limiting.
- Proveedores implementados: Google Drive y Microsoft OneDrive.
- Redis: BullMQ para la cola de transferencias y worker; también queda disponible para cache/estado distribuido futuro.
- CloudFusion Drive: índice virtual, políticas de replicación, réplicas físicas, checksum SHA-256, failover, reparación y papelera.

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

TRANSFER_QUEUE_NAME=cloudfusion-transfers
TRANSFER_WORKER_ENABLED=true
TRANSFER_WORKER_CONCURRENCY=3
TRANSFER_MAX_RETRIES=3
TRANSFER_PROGRESS_INTERVAL_MS=1000
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

## Fase 3

La Fase 3 convierte el explorador en un orquestador multicloud:

- Transferencias cloud-to-cloud Google Drive ↔ OneDrive.
- Operaciones `COPY` y `MOVE`; un `MOVE` elimina el origen únicamente después de verificar el destino.
- Streaming entre adaptadores: el archivo no se carga completo en RAM ni se guarda como ZIP temporal.
- Cola BullMQ sobre Redis, worker con concurrencia configurable, backoff exponencial y hasta tres reintentos por defecto.
- Cancelación, reintento manual, historial persistente, conflictos `RENAME`, `OVERWRITE` y `SKIP`.
- Progreso persistente (`bytesTransferred`, tamaño y porcentaje) y eventos Server-Sent Events en `/transfers/:id/events`.
- Transfer Center en Angular con pestañas de todas, activas, completadas y fallidas.
- Smart Upload, que selecciona el proveedor según reglas de prioridad y espacio disponible conocido.
- Storage Rules por extensión, MIME, tamaño o regla por defecto.
- Búsqueda global concurrente con resultados parciales si un proveedor no responde.
- Auditoría de transferencias y reglas sin registrar tokens ni headers.

### Arquitectura de transferencias

```text
              ┌──────────────────┐
              │     Angular      │
              │ Explorer / SSE   │
              └────────┬─────────┘
                       │ REST
                       ▼
              ┌──────────────────┐
              │ CloudFusion API  │
              └────────┬─────────┘
                       │ BullMQ
                       ▼
              ┌──────────────────┐
              │ Redis + Worker   │
              └───────┬───┬──────┘
                      │   │
             ┌────────┘   └─────────┐
             ▼                      ▼
       Google Drive              OneDrive
```

El worker vive inicialmente dentro del proceso NestJS para simplificar el desarrollo local; `TRANSFER_WORKER_ENABLED=false` permite arrancar solo la API y la misma cola queda preparada para separar un proceso posteriormente.

### Endpoints de Fase 3

| Método | Ruta | Descripción |
| --- | --- | --- |
| POST | `/transfers` | Encolar un COPY o MOVE |
| GET | `/transfers` | Historial del usuario, opcionalmente filtrado por estado |
| GET | `/transfers/:id` | Consultar una transferencia propia |
| POST | `/transfers/:id/retry` | Reintentar una transferencia fallida/cancelada |
| POST | `/transfers/:id/cancel` | Cancelar una transferencia |
| DELETE | `/transfers/:id` | Eliminar un registro no activo |
| GET/SSE | `/transfers/:id/events` | Progreso en tiempo real |
| GET | `/cloud-search?q=` | Búsqueda concurrente multicloud |
| GET | `/storage-rules` | Listar reglas propias |
| POST | `/storage-rules` | Crear regla |
| PATCH | `/storage-rules/:id` | Editar, activar, desactivar o cambiar prioridad |
| DELETE | `/storage-rules/:id` | Eliminar regla |
| POST | `/cloud-files/smart-upload` | Subir usando Smart Storage |

Todos los endpoints están protegidos con el JWT existente y validan ownership por usuario. Los tokens de proveedores permanecen cifrados en PostgreSQL y nunca llegan a Angular ni a los logs.

### Verificación de Fase 3

```powershell
# PostgreSQL y Redis deben estar disponibles
npm --prefix apps/api run migration:run
npm --prefix apps/api test -- --runInBand
npm --prefix apps/api run build
npm --prefix apps/web test -- --watch=false
npm --prefix apps/web run build
```

Las pruebas de Fase 3 mockean Google Drive y OneDrive y cubren ownership, COPY, MOVE seguro, fallos de upload/delete, reglas por prioridad y fallback, búsqueda con fallos parciales y cifrado. La validación real entre nubes requiere credenciales OAuth y cuentas conectadas.

## Fase 4 — CloudFusion Drive

CloudFusion Drive separa la identidad lógica del archivo de su ubicación física:

```text
Angular /drive
      │ JWT
      ▼
VirtualDriveController
      │ PostgreSQL metadata index
      ├── VirtualNode (carpetas, nombres, papelera, favoritos)
      ├── StorageObject (contenido lógico, checksum, política)
      └── StorageReplica (cuenta, proveedor, remoteFileId, estado)
              │ BullMQ / Redis
              ▼
      ReplicationWorker → Google Drive / OneDrive
```

Las carpetas son inicialmente metadata-only. Mover o renombrar en Drive solo cambia `parentId` o `name`; no dispara una transferencia física. Los objetos físicos se guardan bajo una carpeta administrada por CloudFusion (`CloudFusion/objects`) y se identifican con una clave estable independiente del nombre virtual.

### Políticas y estados

- `STANDARD` crea una réplica; `REDUNDANT` puede crear réplicas en cuentas y proveedores distintos; `ARCHIVE` y `CUSTOM` quedan modeladas para extensiones posteriores.
- Un archivo lógico puede estar `AVAILABLE`, `UPLOADING`, `DEGRADED`, `UNAVAILABLE`, `DELETING` o `ERROR`.
- Una réplica puede estar `PENDING`, `UPLOADING`, `HEALTHY`, `DEGRADED`, `MISSING`, `CORRUPTED`, `FAILED`, `DELETING` o `REPAIRING`.
- Las descargas prueban primero réplicas saludables y hacen failover automático. Los fallos se auditan como `REPLICA_FAILOVER`.
- El verificador remoto comprueba existencia, tamaño y SHA-256 por streaming. `REPLICA_AUTO_REPAIR=true` encola una copia desde otra réplica saludable cuando es posible.

### Endpoints del Drive virtual

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/virtual-drive/root` | Inicializa y devuelve la raíz del usuario |
| GET | `/virtual-drive/nodes/:id/children` | Navega el índice virtual |
| POST | `/virtual-drive/folders` | Crea una carpeta metadata-only |
| POST | `/virtual-drive/upload` | Crea el objeto lógico y encola sus réplicas |
| GET | `/virtual-drive/nodes/:id/download` | Descarga con failover |
| PATCH | `/virtual-drive/nodes/:id` | Renombra sin tocar el proveedor |
| POST | `/virtual-drive/nodes/:id/move` | Mueve cambiando solo metadata |
| DELETE | `/virtual-drive/nodes/:id` | Papelera soft-delete |
| POST | `/virtual-drive/nodes/:id/restore` | Restaura desde papelera |
| DELETE | `/virtual-drive/nodes/:id/permanent` | Elimina metadata y réplicas definitivamente |
| GET | `/virtual-drive/recent` | Archivos accedidos recientemente |
| GET | `/virtual-drive/favorites` | Favoritos del usuario |
| GET | `/virtual-drive/trash` | Elementos en papelera |
| GET | `/virtual-drive/storage-overview` | Uso lógico, físico y objetos degradados |
| GET | `/virtual-drive/accounts/:accountId/impact` | Impacto antes de desconectar una cuenta |
| POST | `/virtual-drive/replicas/:replicaId/verify` | Verificación manual de integridad |
| POST | `/virtual-drive/rebalance` | Encola reparaciones para objetos degradados |

Todos los endpoints exigen JWT y filtran por `userId`; un ID de otro usuario devuelve `404` y no permite inferir su existencia. Las migraciones son explícitas y `synchronize` permanece desactivado.

### Variables de entorno de Fase 4

```env
DEFAULT_REPLICATION_FACTOR=1
REPLICA_AUTO_REPAIR=true
REPLICA_VERIFY_INTERVAL_HOURS=24
REPLICATION_WORKER_CONCURRENCY=2
REPLICATION_QUEUE_NAME=cloudfusion-replication
REPLICATION_WORKER_ENABLED=true
TRASH_RETENTION_DAYS=30
STORAGE_REBALANCE_ENABLED=true
```

En desarrollo local sin Redis se puede usar `TRANSFER_WORKER_ENABLED=false` y `REPLICATION_WORKER_ENABLED=false`; la API y la navegación del índice siguen disponibles, pero las cargas físicas quedan pendientes hasta arrancar Redis y los workers.

### Verificación de Fase 4

```powershell
npm --prefix apps/api run migration:run
npm --prefix apps/api test -- --runInBand
npm --prefix apps/api run build
npm --prefix apps/web test -- --watch=false
npm --prefix apps/web run build
```

Las pruebas cubren raíz por usuario, ownership, carpetas, nombres duplicados, movimiento, papelera y restauración. La validación real de réplicas necesita cuentas OAuth conectadas y Redis disponible.

### Limitaciones conocidas

- El estado OAuth de Fase 2 sigue en memoria para desarrollo local; para múltiples instancias debe migrarse a Redis.
- La cuota desconocida no se considera destino válido para Smart Upload.
- El flujo de transferencia de carpetas procesa los archivos individualmente dentro del worker; no crea jobs hijos visibles por cada archivo.
- La reanudación de sesiones resumibles queda preparada a nivel de adaptadores, pero no se implementa una sesión distribuida completa.
- Google Workspace Docs/Sheets/Slides requieren exportación específica si se desea descargar su contenido nativo.

## Fase 5 — Data Protection

La capa de protección se apoya en el Drive virtual y mantiene la replicación separada del backup:

```text
VirtualNode → FileVersion → StorageObject cifrado
                           ├── réplicas para disponibilidad
                           ├── referencias deduplicadas por usuario
                           └── copias de backup verificadas en otra cuenta

FileVersion → Snapshot → Backup → Recovery
```

### Cifrado y deduplicación

- Cada contenido usa una DEK aleatoria de 256 bits y AES-256-GCM. La DEK se protege con una KEK versionada (envelope encryption); PostgreSQL conserva el DEK envuelto y la metadata de integridad, nunca la DEK en claro.
- `CLOUDFUSION_MASTER_KEY` acepta 32 bytes en Base64 o 64 caracteres hexadecimales. Para rotación, configura `CLOUDFUSION_MASTER_KEYS_JSON` con las versiones antigua y nueva, cambia `CLOUDFUSION_KEY_VERSION` y avanza `POST /virtual-drive/security/rotate-keys` con cursor/límite hasta terminar. El endpoint solo reenvuelve DEKs; no vuelve a cifrar cada objeto.
- La deduplicación se limita a archivos del mismo usuario usando SHA-256 del contenido lógico y tamaño. Los objetos cifrados no usan cifrado convergente: dos contenidos iguales pueden tener distinta ciphertext/DEK, aunque compartan el mismo `StorageObject` cuando se deduplican dentro de la cuenta.
- Descarga y verificación operan en streaming. No se registran claves, tokens ni contenido.

### Versiones y snapshots

- Cada carga de un archivo existente agrega un `FileVersion`; restaurar una versión crea una versión actual nueva y conserva las anteriores.
- La retención `KEEP_LAST_N` conserva hasta N versiones recientes, incluida la actual. Versiones referenciadas por snapshots o backups no se recolectan.
- Los snapshots guardan el árbol lógico y referencias a versiones, sin copiar el contenido. Los snapshots marcados protegidos no se eliminan desde la API.
- Con `SNAPSHOT_SCHEDULER_ENABLED=true`, se genera un snapshot diario protegido a las 03:00 UTC para cada Drive inicializado. Los snapshots también se pueden crear y explorar en `/protection`.
- Restaurar un snapshot completo crea un job BullMQ con progreso; restaurar un elemento conserva los elementos existentes usando nombres alternativos por defecto.

### Backups y recuperación

- Las políticas admiten ejecución diaria, semanal o mensual, retención en días y destino en una cuenta cloud conectada. El destino debe ser distinto de la réplica fuente que se está copiando.
- Un backup es distinto de una réplica: captura un snapshot y copia ciphertext al directorio administrado `CloudFusion/Backups` del destino. Solo queda `COMPLETED` después de volver a descargar cada copia y verificar su tamaño y SHA-256 cifrado en streaming.
- Los backups verificados pueden recuperarse desde el centro `/protection`; si falta una réplica accesible, se crea y verifica un blob nuevo en `CloudFusion/objects` desde la copia de backup antes de encolar la restauración. Así, la retención del backup no borra la réplica operativa recuperada.
- La desconexión de una cuenta muestra su impacto en réplicas únicas, versiones, referencias en snapshots y backups; la API exige confirmación explícita si hay contenido afectado.

### Detección y limpieza segura

- El detector agrega eventos auditados de carga/modificación, renombrado y eliminación dentro de una ventana. Al superar el umbral registra `MASS_CHANGE_DETECTED`, muestra una alerta y, si está habilitado, crea un snapshot de emergencia protegido. No bloquea la cuenta automáticamente y no constituye una garantía total contra ransomware.
- La recolección de objetos usa `GC_PENDING` y período de gracia antes de `DELETING`. Antes del sweep revalida versiones, referencias de snapshots y copias de backup bajo lock; el worker de réplicas elimina los blobs físicos. Un fallo de cola vuelve a intentarse en otro ciclo.
- El dashboard informa conteos y ahorro de deduplicación calculados desde los datos existentes; no publica claves ni inventa estimaciones.

### Endpoints principales de Fase 5

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET/POST | `/virtual-drive/nodes/:id/versions` | Historial y nueva versión |
| GET/POST | `/virtual-drive/nodes/:id/versions/:versionId/download` / `restore` | Descargar/restaurar una versión |
| GET/POST/DELETE | `/snapshots` y `/snapshots/:id` | Explorar, crear y eliminar snapshots no protegidos |
| POST | `/snapshots/:id/restore` | Encolar restauración completa |
| GET/POST/PATCH/DELETE | `/backup-policies` | Administrar programación, frecuencia, destino y retención |
| POST | `/backup-policies/:id/run` | Ejecutar backup ahora |
| GET | `/backups` y `/backups/:id` | Historial, estado y verificación |
| POST | `/backups/:id/restore` | Recuperar un backup verificado |
| GET | `/protection/overview` y `/protection/alerts` | Métricas y alertas propias |
| PATCH | `/protection/alerts/:id/resolve` | Marcar alerta revisada |
| SSE | `/protection/events` | Eventos de cifrado, versiones, snapshots, backups, restauraciones y cambios masivos; flujo autenticado y limitado al usuario |

El centro de protección mantiene consultas periódicas como respaldo y se actualiza de inmediato con SSE. El flujo envía heartbeats cada 25 segundos y no incluye contenido de archivos ni material criptográfico.
| GET | `/cloud-accounts/:id/impact` | Impacto antes de desconectar una cuenta |

### Variables de entorno de Fase 5

`CLOUDFUSION_MASTER_KEY` y el keyring son secretos de despliegue; no se deben subir al repositorio ni guardar junto a los blobs cloud. Respalda la clave maestra de forma offline en un gestor de secretos con control de acceso: perder la clave y no tener recuperación puede volver irrecuperables los datos cifrados.

```env
CLOUDFUSION_MASTER_KEY=
CLOUDFUSION_KEY_VERSION=1
CLOUDFUSION_MASTER_KEYS_JSON=
DEFAULT_VERSION_RETENTION_MODE=KEEP_LAST_N
DEFAULT_VERSION_RETENTION_COUNT=10
SNAPSHOT_SCHEDULER_ENABLED=true
EMERGENCY_SNAPSHOT_ENABLED=true
MASS_CHANGE_WINDOW_SECONDS=120
MASS_CHANGE_THRESHOLD=250
MASS_CHANGE_SCAN_INTERVAL_SECONDS=30
STORAGE_GC_ENABLED=true
STORAGE_GC_GRACE_HOURS=24
STORAGE_GC_INTERVAL_MINUTES=60
SNAPSHOT_RESTORE_QUEUE_NAME=cloudfusion-snapshot-restores
SNAPSHOT_RESTORE_WORKER_ENABLED=true
SNAPSHOT_RESTORE_WORKER_CONCURRENCY=1
SNAPSHOT_RESTORE_MAX_RETRIES=3
BACKUP_QUEUE_NAME=cloudfusion-backups
BACKUP_WORKER_ENABLED=true
BACKUP_WORKER_CONCURRENCY=2
BACKUP_MAX_RETRIES=3
BACKUP_SCHEDULE_INTERVAL_SECONDS=30
```

Aplica las migraciones antes de iniciar API y frontend:

```powershell
npm --prefix apps/api run migration:run
npm --prefix apps/api test -- --runInBand
npm --prefix apps/api run build
npm --prefix apps/web test -- --watch=false
npm --prefix apps/web run build
```

PostgreSQL y Redis deben estar disponibles. Backups y restauraciones se procesan por BullMQ; la interfaz consulta estados periódicamente. La conexión real con Google Drive/OneDrive, OAuth, cuotas y restauración entre proveedores requiere credenciales válidas y cuentas conectadas.

## Fuera del alcance actual

CloudFusion todavía no implementa Dropbox, Box, MEGA, pCloud, P2P, BitTorrent, erasure coding/RAID, cifrado end-to-end de conocimiento cero, montaje local, WebDAV, gateway S3, CDN, Kubernetes ni aplicación móvil.
