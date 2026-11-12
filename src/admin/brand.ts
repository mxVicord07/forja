/**
 * Marca del panel (/admin) por configuración. Sin variables, el panel se ve
 * exactamente como siempre (BIRevX). Con ellas, un cliente ve su logotipo y su
 * nombre sin tocar código.
 *
 *   PANEL_BRAND_LOGO_URL  https://… o data:image/(png|jpeg|webp|svg+xml);base64,…
 *   PANEL_BRAND_NAME      nombre corto (máx. 40 caracteres)
 *   PANEL_BRAND_BYLINE    texto bajo «Forja» (por omisión, el nombre)
 *
 * El logotipo se valida estrictamente porque va dentro de un atributo `src`.
 */
import type { Env } from "../env";
import { BRAND_LOGO_DATA_URI } from "./assets/brand-logo";

export interface PanelBrand {
  logo: string;
  name: string;
  byline: string;
}

const LOGO_HTTPS = /^https:\/\/[^\s"'<>\\]+$/i;
const LOGO_DATA = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i;
const MAX_NAME = 40;

export function panelBrand(env: Env): PanelBrand {
  const rawLogo = (env.PANEL_BRAND_LOGO_URL ?? "").trim();
  const logo = rawLogo && (LOGO_HTTPS.test(rawLogo) || LOGO_DATA.test(rawLogo)) ? rawLogo : BRAND_LOGO_DATA_URI;
  const custom = (env.PANEL_BRAND_NAME ?? "").trim().slice(0, MAX_NAME);
  const name = custom || "BIRevX";
  const rawByline = (env.PANEL_BRAND_BYLINE ?? "").trim().slice(0, MAX_NAME);
  const byline = rawByline || (custom ? custom : "by BIRevX");
  return { logo, name, byline };
}
