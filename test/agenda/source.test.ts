import { describe, it, expect } from "vitest";
import {
  normalizeCalBooking,
  mergeCitas,
  fromLocalRow,
  rangoCitas,
  filtrarCitas,
  type CitaPanel,
} from "../../src/agenda/source";
import type { Appointment } from "../../src/db/appointments";

const raw = (over: Record<string, unknown> = {}) => ({
  uid: "uid-1",
  title: "Diagnóstico entre BIRevX y Ana",
  start: "2026-11-16T16:00:00.000Z",
  end: "2026-11-16T16:50:00.000Z",
  duration: 50,
  status: "accepted",
  attendees: [{ name: "Ana Pérez", email: "ana@example.com", timeZone: "America/Mexico_City" }],
  location: "https://teams.microsoft.com/l/meetup-join/abc",
  eventType: { id: 5027054, slug: "diagnostico" },
  ...over,
});

const local = (over: Partial<Appointment> = {}): Appointment => ({
  id: 1,
  conversation_id: "whatsapp:5214441234567",
  calcom_uid: "uid-1",
  event_type_id: 5027054,
  start: "2026-11-16T16:00:00Z",
  status: "confirmed",
  attendee_name: "Ana Pérez",
  attendee_email: "ana@example.com",
  attendee_phone: "+5214441234567",
  created_at: 1,
  updated_at: 1,
  ...over,
});

describe("normalizeCalBooking", () => {
  it("convierte una reserva de Cal.com a la forma del panel", () => {
    const c = normalizeCalBooking(raw())!;
    expect(c).toMatchObject({
      uid: "uid-1",
      titulo: "Diagnóstico entre BIRevX y Ana",
      inicio: "2026-11-16T16:00:00.000Z",
      duracionMin: 50,
      estado: "confirmada",
      origen: "reserva",
      persona: { nombre: "Ana Pérez", correo: "ana@example.com" },
      enlace: "https://teams.microsoft.com/l/meetup-join/abc",
    });
    expect(c.conversacion).toBeNull();
  });

  it("mapea los estados de Cal.com", () => {
    expect(normalizeCalBooking(raw({ status: "pending" }))!.estado).toBe("por_confirmar");
    expect(normalizeCalBooking(raw({ status: "awaiting_host" }))!.estado).toBe("por_confirmar");
    expect(normalizeCalBooking(raw({ status: "cancelled" }))!.estado).toBe("cancelada");
    expect(normalizeCalBooking(raw({ status: "rejected" }))!.estado).toBe("cancelada");
  });

  it("calcula la duración con inicio y fin si no viene", () => {
    expect(normalizeCalBooking(raw({ duration: undefined }))!.duracionMin).toBe(50);
  });

  it("no pone enlace si la ubicación no es una URL", () => {
    expect(normalizeCalBooking(raw({ location: "Oficina del cliente" }))!.enlace).toBeNull();
    expect(normalizeCalBooking(raw({ location: "Oficina del cliente" }))!.lugar).toBe("Oficina del cliente");
  });

  it("descarta reservas sin uid o con fecha inválida", () => {
    expect(normalizeCalBooking(raw({ uid: undefined }))).toBeNull();
    expect(normalizeCalBooking(raw({ start: "no-es-fecha" }))).toBeNull();
    expect(normalizeCalBooking(null)).toBeNull();
  });

  it("tolera una reserva sin asistentes", () => {
    const c = normalizeCalBooking(raw({ attendees: undefined }))!;
    expect(c.persona).toEqual({ nombre: "", correo: "", telefono: null });
  });
});

describe("mergeCitas", () => {
  it("liga la conversación y el teléfono cuando el uid coincide y marca el origen como Lía", () => {
    const [c] = mergeCitas([normalizeCalBooking(raw())!], [local()]);
    expect(c.conversacion).toBe("whatsapp:5214441234567");
    expect(c.origen).toBe("lia");
    expect(c.persona.telefono).toBe("+5214441234567");
  });

  it("un cambio pendiente de la tabla propia manda sobre el estado de Cal.com", () => {
    const [c] = mergeCitas([normalizeCalBooking(raw())!], [local({ status: "change_pending" })]);
    expect(c.estado).toBe("cambio_pendiente");
  });

  it("no agrega filas de la tabla propia que Cal.com no devolvió", () => {
    const out = mergeCitas([normalizeCalBooking(raw())!], [local(), local({ id: 2, calcom_uid: "otro" })]);
    expect(out).toHaveLength(1);
  });

  it("deja sin conversación a las reservas que no agendó Lía", () => {
    const [c] = mergeCitas([normalizeCalBooking(raw({ uid: "nuevo" }))!], [local()]);
    expect(c.conversacion).toBeNull();
    expect(c.origen).toBe("reserva");
  });

  it("ordena por inicio", () => {
    const a = normalizeCalBooking(raw({ uid: "a", start: "2026-11-17T10:00:00Z", end: "2026-11-17T10:50:00Z" }))!;
    const b = normalizeCalBooking(raw({ uid: "b" }))!;
    expect(mergeCitas([a, b], []).map((c) => c.uid)).toEqual(["b", "a"]);
  });
});

describe("fromLocalRow", () => {
  it("arma una cita desde la tabla propia (respaldo si Cal.com falla)", () => {
    const c = fromLocalRow(local({ status: "cancelled" }));
    expect(c).toMatchObject({ uid: "uid-1", estado: "cancelada", origen: "lia", conversacion: "whatsapp:5214441234567" });
    expect(c.duracionMin).toBeNull();
  });
});

describe("rangoCitas", () => {
  const ahora = new Date("2026-11-16T15:30:00Z"); // 09:30 en Ciudad de México
  it("proximas: desde el inicio de hoy hasta 14 días", () => {
    const r = rangoCitas("proximas", ahora, "America/Mexico_City");
    expect(r.desde).toBe("2026-11-16T06:00:00.000Z");
    expect(r.hasta).toBe("2026-11-30T06:00:00.000Z");
  });
  it("hoy cubre un solo día", () => {
    const r = rangoCitas("hoy", ahora, "America/Mexico_City");
    expect(r.hasta).toBe("2026-11-17T06:00:00.000Z");
  });
  it("pasadas: 30 días hacia atrás hasta ahora", () => {
    const r = rangoCitas("pasadas", ahora, "America/Mexico_City");
    expect(r.hasta).toBe(ahora.toISOString());
    expect(r.desde).toBe("2026-10-17T06:00:00.000Z");
  });
  it("un valor desconocido cae en proximas", () => {
    expect(rangoCitas("xx", ahora, "America/Mexico_City").clave).toBe("proximas");
  });
});

describe("filtrarCitas", () => {
  const mk = (uid: string, estado: CitaPanel["estado"], nombre: string): CitaPanel => ({
    uid, titulo: "t", inicio: "2026-11-16T16:00:00Z", duracionMin: 50, estado, origen: "reserva",
    persona: { nombre, correo: `${uid}@x.com`, telefono: null }, lugar: null, enlace: null, conversacion: null,
  });
  const lista = [mk("a", "confirmada", "Ana"), mk("b", "cancelada", "Beto")];
  it("filtra por estado", () => {
    expect(filtrarCitas(lista, { estado: "cancelada" }).map((c) => c.uid)).toEqual(["b"]);
  });
  it("busca por nombre o correo sin importar mayúsculas", () => {
    expect(filtrarCitas(lista, { q: "ANA" }).map((c) => c.uid)).toEqual(["a"]);
    expect(filtrarCitas(lista, { q: "b@x" }).map((c) => c.uid)).toEqual(["b"]);
  });
  it("sin filtros devuelve todo", () => {
    expect(filtrarCitas(lista, {})).toHaveLength(2);
  });
});
