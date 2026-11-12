/**
 * Recordatorio de cita (I-034, rebanada mínima; diferenciador del paquete Negocio).
 *
 * Cada hora busca las citas confirmadas que empiezan en las próximas 2 a 24 h y
 * manda UN recordatorio por cita y horario:
 *   - WhatsApp dentro de la ventana de 24 h (el cliente escribió hace menos de 23 h): texto libre, sin costo.
 *   - WhatsApp fuera de ventana: plantilla aprobada por Meta (CITA_RECORDATORIO_PLANTILLA), por YCloud.
 *     Sin plantilla configurada se salta SIN quemar el candado (puede salir si el cliente vuelve a escribir).
 *   - Telegram: texto libre.
 * La plantilla debe tener 3 variables: {{1}} nombre, {{2}} día, {{3}} hora (como `cita_recordatorio_v1` de BIRevX).
 *
 * Apagado por omisión: FEATURE_RECORDATORIO_CITA="1" y agenda disponible.
 * NO corre en un bot conectado al CRM (CRM_AGENDA_URL): ahí el recordatorio lo
 * manda el semáforo del Copiloto con la guarda de consentimiento, y dos sistemas
 * recordando la misma cita es peor que ninguno.
 * Candado antes de enviar (appointment_id + start): una cita movida recibe su recordatorio nuevo.
 * El cliente pidió la cita por este mismo chat: es un mensaje de servicio sobre algo que solicitó.
 */
import type { Env } from "../env";
import { Db } from "../db/client";
import { MessagesRepo } from "../db/messages";
import { ConversationsRepo } from "../db/conversations";
import { agendaDisponible } from "../config";
import { calcomTimeZone } from "../integrations/calcom";
import { resolveWaProvider } from "../replies/sender";
import { sendYCloudTemplate } from "../channels/ycloud";
import { sendOutbound } from "./send";

const HORA = 3_600_000;
const VENTANA_WA_MS = 23 * HORA;
const TOPE_POR_CORRIDA = 30;

export function recordatorioActivo(env: Env): { activo: boolean; motivo?: string } {
  if (env.FEATURE_RECORDATORIO_CITA !== "1") return { activo: false, motivo: "apagado" };
  if (!agendaDisponible(env)) return { activo: false, motivo: "sin_agenda" };
  if (env.CRM_AGENDA_URL) return { activo: false, motivo: "lo_manda_el_crm" };
  return { activo: true };
}

export function textoRecordatorio(nombre: string, dia: string, hora: string, negocio: string): string {
  const n = nombre.trim().split(/\s+/)[0] || "";
  return `Hola${n ? " " + n : ""}, te recordamos tu cita con ${negocio} el ${dia} a las ${hora}. Si necesitas moverla, respóndeme por aquí.`;
}

let ensured = false;
async function ensureTable(db: Db): Promise<void> {
  if (ensured) return;
  await db.run(
    `CREATE TABLE IF NOT EXISTS cita_recordatorios (
      appointment_id INTEGER NOT NULL, start TEXT NOT NULL, sent_at INTEGER NOT NULL, via TEXT NOT NULL,
      PRIMARY KEY (appointment_id, start))`,
  );
  ensured = true;
}
export function __resetCitaRecordatoriosEnsured(): void { ensured = false; }

interface Candidata {
  id: number; conversation_id: string; start: string; attendee_name: string;
  channel: string | null; channel_user_id: string | null; last_user_at: number | null;
}

export interface ResultadoRecordatorios { enviados: number; saltados: number; fallidos: number; motivo?: string }

export async function runCitaRecordatorios(env: Env, now: number = Date.now()): Promise<ResultadoRecordatorios> {
  const estado = recordatorioActivo(env);
  if (!estado.activo) return { enviados: 0, saltados: 0, fallidos: 0, motivo: estado.motivo };
  const db = new Db(env.DB);
  await ensureTable(db);

  const desde = new Date(now + 2 * HORA).toISOString().slice(0, 19);
  const hasta = new Date(now + 24 * HORA).toISOString().slice(0, 19);
  const filas = await db.all<Candidata>(
    `SELECT a.id, a.conversation_id, a.start, a.attendee_name, c.channel, c.channel_user_id,
            (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = a.conversation_id AND m.role = 'user') AS last_user_at
       FROM appointments a
       LEFT JOIN conversations c ON c.id = a.conversation_id
      WHERE a.status = 'confirmed'
        AND substr(a.start, 1, 19) > ? AND substr(a.start, 1, 19) <= ?
        AND NOT EXISTS (SELECT 1 FROM cita_recordatorios r WHERE r.appointment_id = a.id AND r.start = a.start)
      ORDER BY a.start ASC LIMIT ?`,
    [desde, hasta, TOPE_POR_CORRIDA],
  );

  const tz = calcomTimeZone(env);
  const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("es-MX", { timeZone: tz, ...o }).format(new Date(iso));
  const plantilla = (env.CITA_RECORDATORIO_PLANTILLA ?? "").trim();
  const idioma = (env.CITA_RECORDATORIO_IDIOMA ?? "es_MX").trim();
  const out: ResultadoRecordatorios = { enviados: 0, saltados: 0, fallidos: 0 };

  for (const f of filas) {
    const canal = f.channel;
    const destino = f.channel_user_id;
    if (!canal || !destino) { out.saltados++; continue; }
    const dia = fmt(f.start, { weekday: "long", day: "numeric", month: "long" });
    const hora = fmt(f.start, { hour: "2-digit", minute: "2-digit", hour12: false });
    const texto = textoRecordatorio(f.attendee_name, dia, hora, env.BUSINESS_NAME);
    const enVentana = f.last_user_at != null && now - f.last_user_at < VENTANA_WA_MS;

    let via: "texto" | "plantilla";
    if (canal === "telegram" || (canal === "whatsapp" && enVentana)) via = "texto";
    else if (canal === "whatsapp" && plantilla && resolveWaProvider(env) === "ycloud") via = "plantilla";
    else { out.saltados++; continue; }

    // Candado antes de enviar: si otra corrida ya lo tomó, el INSERT no cambia nada.
    const claim = await db.run(
      "INSERT OR IGNORE INTO cita_recordatorios (appointment_id, start, sent_at, via) VALUES (?, ?, ?, ?)",
      [f.id, f.start, now, via],
    );
    if ((claim as any)?.meta?.changes === 0) { out.saltados++; continue; }

    try {
      if (via === "texto") {
        await sendOutbound(env, { conversationId: f.conversation_id, channel: canal, channelUserId: destino, text: texto }, now);
      } else {
        const nombre = f.attendee_name.trim().split(/\s+/)[0] || "";
        const r = await sendYCloudTemplate(env, { to: destino, name: plantilla, language: idioma, bodyParams: [nombre, dia, hora] });
        if (!r.ok) throw new Error(r.reason);
        // Queda en la Bandeja lo que se mandó (el texto real lo arma la plantilla de Meta).
        await new MessagesRepo(db).append(f.conversation_id, "assistant", `[Recordatorio de cita, plantilla ${plantilla}] ${texto}`);
        await new ConversationsRepo(db).touchLastMessage(f.conversation_id, now);
      }
      out.enviados++;
    } catch (e) {
      // El proveedor no lo aceptó: se suelta el candado para reintentar en la siguiente hora.
      await db.run("DELETE FROM cita_recordatorios WHERE appointment_id = ? AND start = ?", [f.id, f.start]).catch(() => {});
      out.fallidos++;
      console.warn("[cita-recordatorio] no salió:", String((e as Error)?.message ?? e).slice(0, 80));
    }
  }
  return out;
}
