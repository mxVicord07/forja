# Cal.com — ciclo completo de citas

Qué hace el bot con la agenda, cómo se despliega y qué revisar cuando algo falla.

## Qué hace el bot

| Acción | Quién la ejecuta |
|---|---|
| Consultar horarios libres | El bot, solo |
| Agendar una cita | El bot, solo |
| Reagendar | El bot **propone**; un humano aprueba en `/admin/tickets` |
| Cancelar | El bot **registra**; un humano aprueba en `/admin/tickets` |

El bot valida contra Cal.com que el horario propuesto esté libre **antes** de
mandar la solicitud a aprobación: al panel nunca llega una solicitud inválida.

**Tope:** una cita se puede reagendar 3 veces. Al cuarto intento el bot no
genera otra solicitud — pasa la conversación a un humano. Los rechazos no
cuentan contra el tope (la cita nunca se movió).

## Configuración

Secrets y variables (ya documentados en `src/env.ts`):

- `CALCOM_API_KEY` — secret de Cloudflare (`cal_...`)
- `CALCOM_EVENT_TYPE_ID` — event type por defecto
- `CALCOM_EVENT_TYPES` — opcional, JSON `{"corte":123,"barba":456}` para mapear servicio → event type
- `CALCOM_TIMEZONE` — default `America/Mexico_City`

Las tools de agenda son **tier Pro**: requieren `BOT_TIER=pro`.

## Despliegue

**El orden importa.** La migración va antes del deploy: si el código nuevo sube
primero, las tools escriben contra tablas que no existen y el bot falla en vivo.

```bash
# 1. Migración — tablas nuevas (idempotente, se puede repetir sin daño)
pnpm db:apply:remote

# 2. Columna nueva en `tickets`. En este primer deploy la base es nueva, así
#    que schema.sql ya la creó en el paso 1 — este comando fallará con
#    "duplicate column name". ESE ERROR ES ESPERADO. El comando existe como
#    patrón general: si en el futuro schema.sql cambia, esta línea permite
#    agregar la columna a bases existentes.
npx wrangler d1 execute horizontes_bot_db --remote \
  --command "ALTER TABLE tickets ADD COLUMN appointment_change_request_id INTEGER"

# 3. Verificar que las tablas quedaron
npx wrangler d1 execute horizontes_bot_db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'appointment%'"

# 4. Deploy
pnpm run deploy
```

## Prueba de humo tras el deploy

1. Escribirle al bot: "¿qué horarios tienes el viernes?" → espera: una lista de horarios reales (ej. "10:00, 14:30, 16:00"). Si dice "no hay horarios", revisar que `CALCOM_EVENT_TYPE_ID` sea correcto.
2. Agendar una cita → verificar que aparece en Cal.com.
3. Pedir moverla a otro horario libre → el bot dice que quedó **en revisión**, no que ya se movió.
4. Entrar a `/admin/tickets` → debe verse el ticket con **Aprobar / Rechazar**.
5. Aprobar → la cita se mueve en Cal.com y al cliente le llega la confirmación por su canal.

## Cuando algo falla

| Síntoma | Causa probable | Qué revisar |
|---|---|---|
| El bot dice que no hay horarios nunca | `CALCOM_EVENT_TYPE_ID` apunta a un event type inexistente | Verificar el id en Cal.com |
| `calcom_not_configured` | Falta `CALCOM_API_KEY` o el event type | `npx wrangler secret list` |
| `slot_unavailable` con horarios que sí se ven libres | Desfase de zona horaria | Revisar `CALCOM_TIMEZONE` contra la del calendario en Cal.com |
| El ticket sigue abierto tras aprobar | Cal.com rechazó el cambio | `npx wrangler tail` — buscar `[approve-change]` |
| El cambio se aplicó pero el cliente no recibió aviso | Falló el envío por el canal | `npx wrangler tail` — buscar "no se pudo avisar"; escribirle a mano desde la bandeja |
| El bot ya no deja reagendar | Se alcanzó el tope de 3 | Es el comportamiento esperado: la conversación pasa a un humano |
