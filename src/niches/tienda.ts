import type { NichePack } from "./types";

// Nicho: Tienda / comercio minorista (ropa, regalos, papelería, ferretería, abarrotes,
// mascotas, naturista, juguetería, boutique…). Vende PRODUCTOS. El bot resuelve
// disponibilidad, precio, envíos, apartado y pagos, y cuando hay intención de compra
// registra el pedido (registrarPedido) o captura el lead. Nunca inventa stock ni precios.
export const tienda: NichePack = {
  id: "tienda",
  recordSingular: "Pedido",
  recordPlural: "Pedidos",
  navLabel: "Pedidos",
  navIcon: "shopping-bag",
  kpiLabel: "Pedidos",
  // nuevo → preparando → entregado → cancelado
  statusLabels: {
    new: "Nuevo",
    contacted: "Preparando",
    sold: "Entregado",
    lost: "Cancelado",
  },
  columns: [
    { key: "productos", label: "Productos" },
    { key: "entrega", label: "Entrega" },
    { key: "pago", label: "Pago" },
  ],
  defaultTone: "amable, cercano y servicial — como un buen vendedor de mostrador que conoce su mercancía",
  kbDocs: ["catalogo-y-precios", "envios-y-entregas", "pagos-apartado-facturacion", "cambios-devoluciones-garantia", "promociones-y-faq"],
  playbook: `<diagnostic_playbooks>
<playbook name="disponibilidad">
Cliente pregunta "¿tienen X?". Busca en searchKb y, si está habilitado, en catalogQuery.
Si lo encuentras, confirma existencia, precio y variantes (talla/color/modelo). Si NO lo
encuentras o no estás seguro del stock real, NO inventes: ofrece verificar disponibilidad
(handoffHuman) o invita a llamar/visitar.
</playbook>

<playbook name="precio">
Cliente pregunta cuánto cuesta algo. Da el precio o rango de la KB. Si hay variantes,
aclara el rango. Ante regateo/descuento, no prometas nada que no esté confirmado; menciona
promociones SOLO si están en la KB.
</playbook>

<playbook name="envios">
Cliente pregunta si hacen envíos, cuánto tarda o si llega a su ciudad. Responde con la
política de envíos de la KB (local, nacional, costo, envío gratis desde X). Si es una zona
que no conoces, pide el código postal y ofrece confirmar el costo.
</playbook>

<playbook name="apartado_pedido">
Cliente quiere apartar un producto o hacer un pedido. Explica la política de apartado
(anticipo, días). Cuando quiera cerrar, junta los datos: productos, si recoge o es a
domicilio (dirección si aplica) y forma de pago; con eso llama registrarPedido. Confirma
que el negocio lo procesa.
</playbook>

<playbook name="horario_ubicacion_pagos">
Cliente pregunta a qué hora abren, dónde están o cómo pueden pagar. Usa la KB (horarios,
ubicación, métodos de pago y facturación). Comparte el link de Maps cuando convenga.
</playbook>

<playbook name="cambios_devoluciones_mayoreo">
Cliente pregunta por cambios/devoluciones o compra de mayoreo. Explica la política (plazo,
ticket, condiciones). Para mayoreo o un reclamo especial, captura el lead (captureLead) o
pasa a una persona (handoffHuman) para cotizar/resolver.
</playbook>
</diagnostic_playbooks>`,
};
