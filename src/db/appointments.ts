import { Db } from "./client";

export interface Appointment {
  id: number;
  conversation_id: string;
  calcom_uid: string;
  event_type_id: number;
  start: string;
  status: "confirmed" | "change_pending" | "cancelled";
  attendee_name: string;
  attendee_email: string;
  attendee_phone: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateAppointmentInput {
  conversationId: string;
  calcomUid: string;
  eventTypeId: number;
  start: string;
  attendeeName: string;
  attendeeEmail: string;
  attendeePhone?: string;
}

export class AppointmentsRepo {
  constructor(private readonly db: Db) {}

  async create(input: CreateAppointmentInput): Promise<number> {
    const now = Date.now();
    // RETURNING id en vez de meta.last_row_id: es explícito y no depende de
    // cómo tipe D1 los metadatos del INSERT.
    const row = await this.db.first<{ id: number }>(
      `INSERT INTO appointments
         (conversation_id, calcom_uid, event_type_id, start, status,
          attendee_name, attendee_email, attendee_phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)
       RETURNING id`,
      [
        input.conversationId,
        input.calcomUid,
        input.eventTypeId,
        input.start,
        input.attendeeName,
        input.attendeeEmail,
        input.attendeePhone ?? null,
        now,
        now,
      ],
    );
    if (!row) throw new Error("appointments insert no devolvió id");
    return row.id;
  }

  /**
   * Cita vigente de una conversación. Por diseño hay como máximo una:
   * `scheduleAppointment` se niega a agendar si el contacto ya tiene una, así
   * que el ORDER BY solo desempata de forma determinista si alguna vez
   * quedaran dos (datos viejos, una carrera) — no expresa una preferencia de
   * negocio.
   *
   * Incluye 'change_pending' a propósito: las tools necesitan distinguir
   * "no tiene cita" de "ya tiene un cambio en revisión".
   */
  async findActive(conversationId: string): Promise<Appointment | null> {
    return this.db.first<Appointment>(
      `SELECT * FROM appointments
       WHERE conversation_id = ? AND status IN ('confirmed', 'change_pending')
       ORDER BY start DESC LIMIT 1`,
      [conversationId],
    );
  }

  /** Cita por id, sin filtrar por estado — la usa la ruta de aprobación del panel. */
  async getById(id: number): Promise<Appointment | null> {
    return this.db.first<Appointment>("SELECT * FROM appointments WHERE id = ?", [id]);
  }

  async setChangePending(id: number): Promise<void> {
    await this.db.run(
      "UPDATE appointments SET status = 'change_pending', updated_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }

  async revertToConfirmed(id: number): Promise<void> {
    await this.db.run(
      "UPDATE appointments SET status = 'confirmed', updated_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }

  /** Tras un reagendado aprobado: Cal.com dio un uid nuevo, el viejo ya no sirve. */
  async confirmAfterReschedule(id: number, newUid: string, newStart: string): Promise<void> {
    await this.db.run(
      `UPDATE appointments
       SET calcom_uid = ?, start = ?, status = 'confirmed', updated_at = ?
       WHERE id = ?`,
      [newUid, newStart, Date.now(), id],
    );
  }

  async markCancelled(id: number): Promise<void> {
    await this.db.run(
      "UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }
}
