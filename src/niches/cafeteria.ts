import type { NichePack } from "./types";

// Nicho: Cafetería / café de especialidad. El bot toma pedidos para llevar con
// anticipación, aparta mesa, contesta el menú de temporada y recuerda a los
// clientes frecuentes. Vende consumo rápido; usa registrarPedido (comercio).
export const cafeteria: NichePack = {
  id: "cafeteria",
  recordSingular: "Pedido",
  recordPlural: "Pedidos",
  navLabel: "Pedidos",
  navIcon: "coffee",
  kpiLabel: "Pedidos",
  // nuevo → preparando → entregado → cancelado
  statusLabels: {
    new: "Nuevo",
    contacted: "Preparando",
    sold: "Entregado",
    lost: "Cancelado",
  },
  columns: [
    { key: "productos", label: "Pedido" },
    { key: "entrega", label: "Recoge / mesa" },
    { key: "hora", label: "Hora" },
  ],
  defaultTone: "cálido y con buena vibra — como el barista que ya conoce tu pedido de siempre",
  kbDocs: ["menu-y-precios", "cafe-de-especialidad", "horarios-y-ubicacion", "para-llevar-y-mesas", "promociones-y-faq"],
  playbook: `<diagnostic_playbooks>
<playbook name="menu_bebidas">
Cliente pregunta qué tienen o por una bebida/alimento. Llama searchKb("menu") y comparte
opciones con precios. Para café de especialidad, menciona el grano/método si está en KB.
NO inventes productos que no estén en el menú.
</playbook>

<playbook name="pedido_para_llevar">
Cliente quiere dejar un pedido listo para recoger. Junta: qué quiere, tamaño/variantes,
a qué hora pasa y cómo paga. Con eso llama registrarPedido con entrega "recoger" y en
fecha la hora a la que pasa (ej. "hoy 10:30"). Avisa
que se lo dejan listo en barra a esa hora.
</playbook>

<playbook name="apartar_mesa">
Cliente quiere apartar mesa o un rincón (para trabajar, reunión). Pide personas y hora, y
si aplica alguna preferencia (enchufe, terraza). Regístralo con captureLead (intent =
"Apartar mesa · N pers · HH:MM", y la preferencia en notes). Confirma que el café lo aparta.
</playbook>

<playbook name="encargo_pastel_evento">
Cliente pide un pastel, charola o pedido grande para un evento. Toma producto, cantidad y
fecha; para algo a la medida o de alto volumen, captura el lead (captureLead) o pasa a una
persona (handoffHuman) para cotizar y confirmar disponibilidad.
</playbook>

<playbook name="horario_ubicacion">
Cliente pregunta a qué hora abren, dónde están o si hay wifi/estacionamiento. Usa la KB
(horarios, ubicación, amenidades). Comparte el link de Maps cuando convenga.
</playbook>
</diagnostic_playbooks>`,
};
