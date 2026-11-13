/**
 * Contactos que el dueño atendió desde su app de WhatsApp Business (coexistencia).
 * Forja guarda esos mensajes como `owner` en cada conversación. Aquí se listan
 * las conversaciones recientes con mensajes del dueño, para cruzarlas con Odoo
 * y mostrar las que todavía no están registradas allá (idea I-012).
 */
import { Db } from "../db/client";

export interface ContactoCoexistencia {
  conversationId: string;
  telefono: string; // E.164 con "+"
  nombre: string | null;
  ultimoDelDueno: number;
  mensajesDelDueno: number;
  ultimoTexto: string | null;
  respondio: boolean;
}

const DIA = 86_400_000;

export async function contactosCoexistencia(db: Db, now: number = Date.now(), dias = 14): Promise<ContactoCoexistencia[]> {
  const filas = await db.all<{
    id: string; channel_user_id: string; display_name: string | null; ultimo: number; n: number; texto: string | null; resp: number | null;
  }>(
    `SELECT c.id, c.channel_user_id, c.display_name, MAX(m.created_at) AS ultimo, COUNT(*) AS n,
            (SELECT content FROM messages x WHERE x.conversation_id = c.id AND x.role = 'owner' ORDER BY x.created_at DESC LIMIT 1) AS texto,
            (SELECT MAX(u.created_at) FROM messages u WHERE u.conversation_id = c.id AND u.role = 'user') AS resp
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id AND m.role = 'owner'
      WHERE c.channel = 'whatsapp' AND m.created_at > ?
      GROUP BY c.id ORDER BY ultimo DESC LIMIT 80`,
    [now - dias * DIA],
  );
  return filas
    .map((f) => ({
      conversationId: f.id,
      telefono: "+" + String(f.channel_user_id).replace(/\D/g, ""),
      nombre: f.display_name && f.display_name.trim() ? f.display_name.trim().slice(0, 80) : null,
      ultimoDelDueno: f.ultimo,
      mensajesDelDueno: f.n,
      ultimoTexto: f.texto ? f.texto.replace(/\s+/g, " ").trim().slice(0, 140) : null,
      respondio: f.resp != null && f.resp > f.ultimo - 14 * DIA,
    }))
    .filter((c) => /^\+\d{11,13}$/.test(c.telefono));
}
