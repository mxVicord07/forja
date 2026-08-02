# Instrucción maestra viva — auditoría y gobernanza

> Estado: aprobado, pendiente de implementación · 2026-08-01

## Problema

Forja ensambla la instrucción maestra (system prompt) del bot en runtime,
mezclando el `TEMPLATE` versionado en git (`src/system-prompt.ts`) con valores
mutables en D1 (`settings`: tono, contexto de negocio, reglas de formato,
lecciones del flywheel, etc.). El único lugar donde se ve el prompt efectivo
completo es un `<textarea>` de solo-lectura-de-facto en el panel admin
(`src/admin/views/agente.ts`).

Tres huecos concretos:

1. **Cero historial.** `settings` es `key, value, updated_at` con
   `ON CONFLICT DO UPDATE` — el valor anterior se destruye en cada escritura.
2. **El flywheel muta la instrucción sin dejar rastro.** Con
   `autonomy_level="copilot"`, el cron nocturno auto-aplica lecciones
   sobreescribiendo `learned_lessons` (un array JSON en una fila). No hay
   forma de saber qué se agregó, cuándo, ni de revertirlo.
3. **Nada diffable ni portable.** El prompt efectivo es un string efímero:
   no está en git, no sobrevive la pérdida del D1, no se puede comparar
   entre momentos en el tiempo ni entre dispositivos.

## Alcance

Dentro: el system prompt efectivo completo (template + tono + formato +
contexto de negocio + lecciones del flywheel + lista de tools habilitadas) y
un changelog de cómo llegó a ese estado.

Fuera de este diseño (explícitamente pospuesto): inventario de documentos de
Knowledge Base, y un registro de qué recurso externo (Drive, calendario, base
de productos) usa cada tool — esa capa no existe todavía en Forja y necesita
su propio diseño cuando se decida construirla.

## Enfoques considerados

- **A — Snapshot manual + diff en git.** Barato, pero sin atribución: un
  changelog de git mezclaría en un solo diff un cambio del owner y uno del
  flywheel del mismo período, sin poder distinguir cuál es cuál. Descartado
  porque no responde la pregunta que motiva este trabajo.
- **B — Auditoría en D1 + `.md` generado.** *(elegido)* Captura en el
  chokepoint real de escritura (`SettingsRepo.set()`), con atribución
  (`owner` / `flywheel` / `system`) y timestamps exactos. Costo: una
  migración, un método tocado en el camino caliente, un endpoint, un script.
- **C — Snapshot nocturno automático.** Más simple que B pero pierde
  atribución igual que A, y depende del orden de ejecución del cron
  (¿la foto es antes o después de que el flywheel corra la misma noche?).
  Descartado por frágil.

## Arquitectura

```
Panel admin ──┐
Flywheel  ────┼──> SettingsRepo.set(key, value, actor)
Watchdog  ────┘         │
                        ├─ ¿old !== new? ─ no ──> no hace nada
                        │                  sí
                        └──> batch atómico:
                             1. INSERT settings_history
                             2. UPSERT settings
                                  │
                                  ▼
                        GET /admin/instruccion-maestra.md
                        (prompt efectivo + changelog, secretos redactados)
                                  │
                        pnpm prompt:sync
                                  ▼
                   FORJA/_context/instruccion-maestra.md   (OneDrive)
```

Decisiones de diseño no obvias:

- **Solo se registra si el valor cambió de verdad.** El panel admin escribe
  todas las keys de un formulario de golpe en cada guardado
  (`src/admin/routes.ts`), así que sin esta comparación cada guardado genera
  ~15 filas de historial aunque nada haya cambiado.
- **El batch es atómico, no best-effort.** Si el insert de historial se
  hiciera con `try/catch` para "no romper nada", el registro podría perderse
  en silencio — inutilizando el propósito de auditoría. O se guardan los dos
  (setting + historial) o no se guarda ninguno.
- **Ubicación del `.md`: `FORJA/_context/` en OneDrive, no dentro del fork
  `~/Dev/forja`.** El fork es (potencialmente) público / candidato a PRs
  upstream; el `.md` generado contiene `business_context` real de BIRevX
  (precios, proceso comercial). Separar evita que ese contenido comercial
  viaje con el código si el fork se abre.
- **El archivo se regenera completo en cada sync, nunca se le agrega al
  final.** Reproducible, sin deriva entre corridas. El alcance del changelog
  queda definido por la retención en D1 (ver Purga).

## Componentes

### 1. Migración — tabla `settings_history`

En `src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS settings_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT    NOT NULL,
  old_value  TEXT,              -- NULL = la key no existía antes
  new_value  TEXT    NOT NULL,
  actor      TEXT    NOT NULL,  -- 'owner' | 'flywheel' | 'system'
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settings_history_changed
  ON settings_history(changed_at DESC);
```

### 2. `Db.batch()`

Nuevo método en `src/db/client.ts`, envolviendo `d1.batch()`, para que el
insert de historial y el upsert de `settings` sean atómicos.

### 3. `SettingsRepo.set(key, value, actor = "system")`

`actor` es un parámetro opcional con default seguro — los ~20 call sites
existentes (`src/admin/routes.ts`, `src/watchdog.ts`, `src/learn/mapping.ts`,
`src/flywheel/detect.ts`) siguen compilando sin tocarse. `"system"` como
default es deliberado: preferible que algo aparezca sin atribuir a que se
etiquete falsamente como acción del owner.

Solo tres sitios pasan `actor` explícito:
- `src/admin/routes.ts` → `"owner"`
- `src/flywheel/detect.ts::saveLessons` → `"flywheel"`
- el resto queda en `"system"` (default)

Internamente: lee el valor actual, si `old !== new` arma el batch atómico
(insert historial + upsert), si son iguales solo hace el upsert normal (o ni
eso, si el valor es idéntico).

### 4. Endpoint `GET /admin/instruccion-maestra.md`

Detrás del Basic Auth existente del panel. Devuelve `Content-Type:
text/markdown`. Compone:

- `resolveAgentConfig()` para el prompt ya resuelto y el estado actual
  (modelo, idioma, autonomía, tools habilitadas/deshabilitadas).
- Un aviso explícito si `system_prompt_override` está activo — porque en ese
  caso el prompt generado y las lecciones del flywheel se ignoran en
  silencio (`settings-loader.ts`), y el changelog de lecciones sería
  engañoso sin esta advertencia.
- El changelog derivado de `settings_history`, renderizado con reglas
  distintas por tipo de valor (ver siguiente sección).

**Redacción de secretos, obligatoria.** `settings` incluye `llm_api_key`. El
generador mantiene una lista explícita de keys redactadas
(`llm_api_key`, y cualquier otra que se agregue a futuro) que se muestran
como `••••` tanto en el estado actual como en cualquier entrada del
changelog que las involucre. Sin esto, una API key terminaría en texto plano
dentro de un archivo sincronizado a todos los dispositivos por OneDrive.

### 5. Script `pnpm prompt:sync`

Baja el endpoint y escribe el archivo en
`FORJA/_context/instruccion-maestra.md`. La ruta de OneDrive (con espacios,
específica de esta máquina) sale de una variable de entorno con default, no
hardcodeada. La contraseña del dashboard se lee del entorno — nunca aparece
en el script ni se commitea.

**Escritura segura:** el script escribe a un archivo temporal, valida que la
respuesta sea 200 y que el `Content-Type` sea markdown, y recién ahí mueve
el temporal sobre el archivo final. Sin esto, un 401 (credenciales vencidas)
devolvería una página HTML de error que reemplazaría en silencio el último
respaldo bueno.

### 6. `purgeOldSettingsHistory`

Se suma al cron nocturno de las 3am que ya existe (`src/index.ts` →
`src/crons/`), espejando el patrón de `purgeOldMessages`. Retención: 365
días — los cambios de configuración son de bajo volumen (pocos por semana),
sin razón para purgar tan agresivo como los mensajes (90 días).

## El changelog — formato y reglas de renderizado

```markdown
# Instrucción Maestra — BIRevX Support Bot
> Generado: 2026-08-01 22:15 · birevx-support-bot

## ⚠️ Avisos            ← solo aparece si hay algo que avisar
- `system_prompt_override` ACTIVO: el prompt generado y las 7
  lecciones del flywheel se están ignorando.

## Estado actual
Modelo: auto · Idioma: espejo · Autonomía: copilot
Tools habilitadas: searchKb, captureLead, handoffHuman
Tools deshabilitadas: scheduleAppointment

## Prompt efectivo
(el texto completo, exactamente como lo recibe el modelo)

## Lecciones aprendidas (7 activas)
1. …

## Changelog
### 2026-08-01
- 03:14 · **flywheel** · lecciones
  + "Si preguntan precio sin contexto, pedir tipo de negocio primero"
- 21:40 · **owner** · formatting_rules
  "" → "Usa negritas para nombres de servicio"
```

Tres reglas de renderizado según el tipo de valor:

- **Lecciones (`learned_lessons`):** se parsean ambos arrays JSON (antes/
  después) y se muestra el diff semántico — qué lección entró, cuál salió —
  nunca los dos blobs JSON completos. Es la diferencia entre un documento
  legible y uno que se va a ignorar.
- **Valores cortos** (tono, idioma, modelo, temperatura, etc.):
  `"antes" → "después"` directo.
- **Textos largos** (`business_context`, `system_prompt_override`): diff por
  líneas, mostrando solo las líneas que cambiaron, con corte a N líneas y un
  "…y 12 líneas más" si excede. Volcar dos versiones completas de >1000
  caracteres en cada entrada haría el archivo inservible.

## Manejo de errores

- **Orden de despliegue:** la migración debe aplicarse antes que el deploy
  del código nuevo. Si el código que espera `settings_history` se despliega
  primero, toda escritura de settings falla (panel, flywheel, watchdog) hasta
  que la migración se aplique. Va documentado en el runbook de despliegue,
  no solo en la memoria de quien lo hizo.
- **El generador nunca devuelve un documento parcial.** Si D1 falla a mitad
  de la composición, responde 503. Un `.md` incompleto es peor que ninguno.
- **El script no pisa el archivo bueno si algo salió mal** (ver sección 5,
  escritura segura vía temporal + validación).

## Testing

Con vitest + `createTestMiniflare()`, siguiendo el patrón existente del repo:

- Guardar un valor sin cambiarlo **no** genera fila de historial.
- `old_value` es `NULL` en la primera escritura de una key.
- El actor por defecto es `"system"`; `"owner"` y `"flywheel"` se registran
  cuando se pasan explícitos.
- Atomicidad: si el insert de historial falla, el setting **no** queda
  modificado (ni viceversa).
- El diff de lecciones calcula correctamente agregadas y quitadas.
- `llm_api_key` no aparece en texto plano en ninguna salida del generador
  (ni estado actual ni changelog).
- El aviso de `system_prompt_override` activo aparece cuando corresponde.
- La purga respeta el corte de 365 días.

## Fuera de alcance (explícito)

- Rollback automático de settings desde el `.md` o el historial — este
  diseño es de solo-lectura/auditoría. Un mecanismo de revertir se puede
  construir después, sobre esta misma tabla, sin rediseñar nada.
- Inventario de documentos de Knowledge Base.
- Registro de qué recurso externo usa cada tool (Drive, calendario, base de
  productos) — capa que no existe hoy en Forja.
