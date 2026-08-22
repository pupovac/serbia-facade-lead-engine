/**
 * Display formatting — and nothing else.
 *
 * Turning `+381641234567` into `064 123 4567` is presentation. Deciding *which*
 * number is the one to dial is a rule the export needs too, so it lives in
 * `src/lib/review`. Nothing in this file derives a value; it only renders one.
 */
import type { LeadClassification } from '@/lib/db';

/** Serbian labels — a salesperson reads this screen, not an engineer. */
export const CLASSIFICATION_LABELS: Record<LeadClassification, string> = {
  FACADE_CONTRACTOR: 'Fasaderi',
  CONSTRUCTION_MATERIAL_STORE: 'Stovarišta',
  BOTH: 'Oba',
  UNCLASSIFIED: 'Nerazvrstano',
  OUT_OF_SCOPE: 'Van opsega',
};

/** Serbian names for the adjacent trade an `OUT_OF_SCOPE` lead was ruled out as. */
export const INDUSTRY_LABELS: Record<string, string> = {
  roofing: 'krovopokrivači',
  joinery: 'stolarija',
  waterproofing: 'hidroizolacija',
  industrial_insulation: 'industrijska izolacija',
  electrical: 'elektroinstalacije',
  cleaning: 'čišćenje',
  manufacturing: 'proizvodnja',
  other_trade: 'drugi zanat',
  general_construction: 'opšta gradnja',
  technical_goods: 'tehnička roba',
};

export const STATUS_LABELS: Record<string, string> = {
  new: 'Novo',
  reviewed: 'Pregledano',
  approved: 'Odobreno',
  rejected: 'Odbijeno',
  merged: 'Spojeno',
};

export const FIELD_LABELS: Record<string, string> = {
  name: 'Naziv',
  legal_form: 'Pravna forma',
  address: 'Adresa',
  postal_code: 'Poštanski broj',
  city: 'Grad',
  municipality: 'Opština',
  classification: 'Tip',
  description: 'Opis',
  opening_hours: 'Radno vreme',
  registration_number: 'Matični broj',
  tax_id: 'PIB',
  coordinates: 'Koordinate',
  activity_code: 'Šifra delatnosti',
  activity_name: 'Naziv delatnosti',
};

export const CONTACT_LABELS: Record<string, string> = {
  email: 'E-pošta',
  website: 'Sajt',
  facebook: 'Facebook',
  instagram: 'Instagram',
  google_maps: 'Google Maps',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  other: 'Ostalo',
};

const PHONE_TYPE_LABELS: Record<string, string> = {
  mobile: 'mobilni',
  landline: 'fiksni',
  toll_free: 'besplatni',
  voip: 'VoIP',
  unknown: '—',
};

export function phoneTypeLabel(type: string): string {
  return PHONE_TYPE_LABELS[type] ?? type;
}

/**
 * `+381641234567` → `064 123 4567`.
 *
 * Serbia's national form is what someone actually dials, and it is what the
 * stored `national_format` holds when the parser produced one. This is the
 * fallback for the claims that predate it.
 */
export function formatPhone(e164: string, national?: string | null): string {
  if (national) return national;
  const match = /^\+381(\d{2})(\d{6,7})$/.exec(e164);
  if (!match) return e164;
  const [, area, rest] = match;
  if (!area || !rest) return e164;
  const head = rest.slice(0, 3);
  const tail = rest.slice(3);
  return `0${area} ${head} ${tail}`.trim();
}

const DATE = new Intl.DateTimeFormat('sr-Latn-RS', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const DATE_TIME = new Intl.DateTimeFormat('sr-Latn-RS', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(value: Date | null | undefined): string {
  return value == null ? '—' : DATE.format(value);
}

export function formatDateTime(value: Date | null | undefined): string {
  return value == null ? '—' : DATE_TIME.format(value);
}

const NUMBER = new Intl.NumberFormat('sr-Latn-RS');

export function formatNumber(value: number): string {
  return NUMBER.format(value);
}

export function formatPercent(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

/** A score band, so a 90 and a 30 do not look the same at a glance. */
export function scoreBand(score: number): 'high' | 'mid' | 'low' {
  if (score >= 75) return 'high';
  if (score >= 45) return 'mid';
  return 'low';
}

/** Shorten a URL to something that fits a table cell without losing the host. */
export function shortUrl(url: string, max = 56): string {
  const trimmed = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
