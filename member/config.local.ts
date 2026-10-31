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
      "Dos pilares que se conectan (fuente: base comercial de BIRevX). Pilar 1, que no se pierdan clientes: asistentes de WhatsApp con IA, agentes de voz que contestan y llaman por teléfono, seguimiento automático, marketing y contenido con IA (avatares y video) y un asistente operativo para el dueño o el equipo. Pilar 2, que el negocio se pueda operar y controlar: CRM, punto de venta, inventario y compras, cobros y facturación, ERP con Odoo, tableros, automatización de procesos y diseño/rediseño de sitios web (desde $6,490 MXN — ver 'Precios de sitios web' abajo). Todo a la medida, conectado con lo que el cliente ya usa y sobre infraestructura a su nombre. Da el mismo peso a los dos pilares: no presentes a BIRevX solo como una agencia de chatbots.",
    Precios:
      "Todos los precios son + IVA y SIEMPRE tienen dos partes distintas: la IMPLEMENTACIÓN (pago único) y la MENSUALIDAD (cada mes). Nunca digas 'al mes' de una implementación ni mezcles las dos. Desde: asistentes conversacionales: implementación desde $17,500 MXN + mensualidad desde $3,500 MXN (tres paquetes; el de en medio, Negocio, es el recomendado). Agentes de voz: implementación desde $15,000 MXN + mensualidad desde $2,500 MXN. Asistente operativo para el dueño o el equipo: implementación desde $32,000 MXN + mensualidad desde $2,900 MXN. Marketing y contenido con IA: solo mensualidad, desde $6,500 MXN al mes (la pauta va aparte). Diseño de sitios web: desde $6,490 MXN, pago por plan (ver el campo siguiente). Automatización a la medida: rango típico $17,500-$70,000 MXN según el alcance. ANTES de dar cualquier precio o decir qué incluye un paquete, usa searchKb de esa línea y apégate a lo que dice; no inventes inclusiones ni digas que un precio es 'competitivo' ni lo compares con otros. Da el precio solo si lo preguntan, siempre como 'desde', y aclara que el precio exacto se define después de un diagnóstico inicial sin costo — nunca antes. El consumo de terceros (WhatsApp, IA, minutos) se explica aparte. NO ofrezcas descuentos ni promociones: si los piden, los define Victor después del diagnóstico.",
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
