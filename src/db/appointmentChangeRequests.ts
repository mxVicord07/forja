import { Db } from "./client";

export type ChangeKind = "reschedule" | "cancel";

export interface AppointmentChangeRequest {
  id: number;
  appointment_id: number;
  conversation_id: string;
  kind: ChangeKind;
  proposed_start: string | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  requested_at: number;
  resolved_at: number | null;
}

export interface CreateChangeRequestInput {
  appointmentId: number;
  conversationId: string;
  kind: ChangeKind;
  proposedStart?: string;
  reason?: string;
}

export class AppointmentChangeRequestsRepo {
  constructor(private readonly db: Db) {}

  // Inserta una nueva solicitud de cambio. Se crea siempre en estado 'pending'
  // y retorna su ID para consultas posteriores.
  async create(input: CreateChangeRequestInput): Promise<number> {
    const row = await this.db.first<{ id: number }>(
      `INSERT INTO appointment_change_requests
         (appointment_id, conversation_id, kind, proposed_start, reason, status, requested_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)
       RETURNING id`,
      [
        input.appointmentId,
        input.conversationId,
        input.kind,
        input.proposedStart ?? null,
        input.reason ?? null,
        Date.now(),
      ],
    );
    if (!row) throw new Error("appointment_change_requests insert no devolvió id");
    return row.id;
  }

  // Recupera una solicitud por ID. Retorna null si no existe.
  async getById(id: number): Promise<AppointmentChangeRequest | null> {
    return this.db.first<AppointmentChangeRequest>(
      "SELECT * FROM appointment_change_requests WHERE id = ?",
      [id],
    );
  }

  // Marca una solicitud como aprobada y registra el timestamp de resolución.
  // Un aprobado significa que el cambio será ejecutado en la cita real.
  async approve(id: number): Promise<void> {
    await this.db.run(
      "UPDATE appointment_change_requests SET status = 'approved', resolved_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }

  // Marca una solicitud como rechazada y registra el timestamp de resolución.
  // Un rechazo significa que la cita no se mueve (no se cuenta en topes).
  async reject(id: number): Promise<void> {
    await this.db.run(
      "UPDATE appointment_change_requests SET status = 'rejected', resolved_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }

  // Cuántos cambios de este tipo YA se ejecutaron sobre la cita. Alimenta el
  // tope de 3 reagendamientos: solo cuentan los aprobados, porque un rechazo
  // significa que la cita nunca se movió.
  async countApproved(appointmentId: number, kind: ChangeKind): Promise<number> {
    const row = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) as n FROM appointment_change_requests
       WHERE appointment_id = ? AND kind = ? AND status = 'approved'`,
      [appointmentId, kind],
    );
    return row?.n ?? 0;
  }
}
