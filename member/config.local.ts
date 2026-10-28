// member/config.local.ts
// Business-specific configuration. Edited by the member (or by the skill
// /configurar-mi-chatbot). NEVER overwritten on template update.
//
// This is a stub with example values. Replace with your real business info.

export const memberConfig = {
  businessName: "BIRevX",
  botName: "BIRevX Support Bot",
  language: "es" as "es" | "en",
  tier: "free" as "free" | "pro",
  timezone: "America/Mexico_City",
  contactEmail: "contacto@birevx.com",
};

export type MemberConfig = typeof memberConfig;

// Business context consumed by src/businessContext.ts to render the
// <business_context> section of the system prompt. Edit freely.
export const businessConfig = {
  hours: "Lunes a viernes 10:00-19:00, sábados 10:00-14:00. Fuera de ese horario, disponibilidad por cita.",
  services: [] as { name: string; price: number }[],
  location: "San Luis Potosí, SLP (oficina física) — atendemos clientes 100% remoto en toda LATAM.",
  paymentMethods: ["efectivo", "transferencia bancaria", "MercadoPago"],
  contactPhone: "",
  customFields: {
    "Quiénes somos":
      "BIRevX es una agencia de consultoría en automatización con IA. Su marca hermana BSEBI aporta la ingeniería de infraestructura de negocio. Juntas diseñan, construyen y evolucionan la infraestructura digital de una PyME para que sea sostenible, escalable y de su propiedad.",
    Servicios:
      "Infraestructura digital (VPS/hosting autoalojado), CRM, ERP, dashboards y reportes (Power BI/Excel/SQL), automatización de flujos con IA, integración de IA (API keys), asistentes operativos de WhatsApp con IA, asistentes operativos internos para el dueño o el equipo, agentes de voz que contestan y llaman por teléfono, diseño/rediseño de sitios web (desde $6,490 MXN — ver 'Precios de sitios web' abajo), y marketing con IA (avatares y video).",
    Precios:
      "Cada línea de servicio tiene sus propios precios, todos + IVA, y están en la base de conocimiento: búscalos ahí por línea antes de dar un número, y no mezcles los de una línea con otra. Desde: asistentes conversacionales $17,500 MXN (tres paquetes, el de en medio es el recomendado); agentes de voz $15,000 MXN; marketing y contenido con IA $6,500 MXN al mes; asistente operativo para el dueño o el equipo $32,000 MXN; diseño de sitios web desde $6,490 MXN; automatización a la medida, rango típico $17,500-$70,000 MXN según el alcance. Las mensualidades y el consumo de terceros (WhatsApp, IA, minutos) se explican aparte. Da el precio solo si lo preguntan, siempre como 'desde'. El precio exacto se define después de un diagnóstico inicial sin costo — nunca antes. NO ofrezcas descuentos ni promociones: si los piden, los define Victor después del diagnóstico.",
    "Precios de sitios web":
      "Diseño/rediseño web tiene planes con precio fijo, no cotización a la medida: Start $6,490 MXN, Business $9,890 MXN (más popular), Growth desde $14,890 MXN, Proyecto Especial desde $22,000 MXN — todos + IVA. Rediseño de un sitio existente: $4,500 a $25,000 MXN según qué tanto cambia. Detalle completo (qué incluye cada plan, proceso) en la base de conocimiento — búscalo ahí antes de responder con números de sitios web, y comparte el PDF de paquetes con shareDocument si lo piden por escrito.",
    "Formas de pago próximamente": "Stripe (en integración, aún no disponible).",
    "Contacto directo": "WhatsApp — https://wa.me/message/ZP7XYEAVEBJ7H1",
  } as Record<string, string>,
};

// Product catalog consumed by src/tools/catalogQuery.ts (Pro tier).
// Member fills via skill. Example:
//   { name: "Pan dulce", price: 25, description: "Concha tradicional", sku: "PD-01" }
export const catalog: { name: string; price: number; description?: string; sku?: string }[] = [];
