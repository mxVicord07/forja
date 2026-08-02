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
      "Infraestructura digital (VPS/hosting autoalojado), CRM, ERP, dashboards y reportes (Power BI/Excel/SQL), automatización de flujos con IA, integración de IA (API keys), asistentes operativos de WhatsApp con IA, agentes de voz, diseño/rediseño de sitios web, y marketing con IA (avatares y video).",
    Precios:
      "Cada proyecto se cotiza según su alcance — rango típico $17,500-$70,000 MXN (aprox. $1,000-4,000 USD), según los servicios combinados. Para inversiones grandes: pago en bloques. El precio exacto se define después de un diagnóstico inicial sin costo — nunca antes.",
    "Formas de pago próximamente": "Stripe (en integración, aún no disponible).",
    "Contacto directo": "WhatsApp — https://wa.me/message/ZP7XYEAVEBJ7H1",
  } as Record<string, string>,
};

// Product catalog consumed by src/tools/catalogQuery.ts (Pro tier).
// Member fills via skill. Example:
//   { name: "Pan dulce", price: 25, description: "Concha tradicional", sku: "PD-01" }
export const catalog: { name: string; price: number; description?: string; sku?: string }[] = [];
