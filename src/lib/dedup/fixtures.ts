/**
 * The golden fixture set: 54 scraped records that are 43 businesses.
 *
 * Every record is shaped like something a Stage 4 adapter will actually emit —
 * a directory listing, a classifieds ad, a Facebook page, a company's own
 * contact page — and every duplicate in here is a duplicate this market really
 * produces:
 *
 * - one fasader on four directories, spelled four different ways
 * - a landline on one listing and a mobile on another, same business
 * - a company reached only through its own domain on one source and only
 *   through its email on another
 * - two `Fasade Petrović` that are two businesses, in two cities
 * - two near-identical names in *one* city that are still two businesses
 * - a stovarište with two yards, two addresses and one phone
 * - five unrelated companies printing one listing service's switchboard
 * - a directory that prints its own contact address on every entry it lists
 *
 * `business` is the ground truth: records sharing it are one business and must
 * end up as one lead. It is never read by the engine — only by the test that
 * checks the engine got the same answer.
 *
 * The counts asserted in `golden.test.ts` are derived from this file, not typed
 * next to it, so adding a record here cannot silently invalidate the assertion.
 */
import type { LeadInput, Provenance } from '../db/repo.js';
import { normalizeCompanyName } from '../normalize/index.js';

/** The Stage 1 sources these records came off, with their registry priority. */
export const FIXTURE_SOURCES = [
  { id: 'portal-srbija', name: 'Portal Srbija', priority: 'high' },
  { id: 'navidiku-rs', name: 'Na vidiku', priority: 'high' },
  { id: 'gradjevinarstvo-rs', name: 'Gradjevinarstvo.rs', priority: 'medium' },
  { id: 'oglasi-rs', name: 'Oglasi', priority: 'low' },
  { id: 'facebook-pages', name: 'Facebook pages', priority: 'medium' },
  { id: 'own-website', name: 'Company websites', priority: 'high' },
] as const;

export type FixtureSourceId = (typeof FIXTURE_SOURCES)[number]['id'];

export interface FixtureRecord {
  /** Ground truth. Records sharing this key are one business. */
  readonly business: string;
  readonly source: FixtureSourceId;
  readonly path: string;
  readonly name: string;
  readonly cityId?: string;
  readonly municipalityId?: string;
  readonly cityRaw?: string;
  readonly address?: string;
  readonly description?: string;
  readonly registrationNumber?: string;
  readonly phones?: readonly {
    readonly e164: string;
    readonly raw: string;
    readonly landline?: boolean;
  }[];
  readonly email?: string;
  readonly website?: { readonly url: string; readonly domain: string };
  readonly facebook?: string;
}

/* -------------------------------------------------------------------------- */

export const FIXTURES: readonly FixtureRecord[] = [
  /* -- 1. One fasader, four directories, four spellings, one mobile -------- */
  {
    business: 'fasader-plus',
    source: 'portal-srbija',
    path: '/fasaderski-radovi-novi-sad',
    name: 'Fasader Plus d.o.o.',
    cityId: 'novi-sad',
    municipalityId: 'novi-sad',
    cityRaw: 'Novi Sad',
    description: 'Izrada demit fasada i termoizolacija stambenih objekata.',
    phones: [{ e164: '+381641112233', raw: '064/111-2233' }],
  },
  {
    business: 'fasader-plus',
    source: 'navidiku-rs',
    path: '/firme/fasaderski-radovi/novi-sad/fasader-plus',
    name: 'FASADER PLUS DOO',
    cityId: 'novi-sad',
    municipalityId: 'novi-sad',
    cityRaw: 'Novi Sad',
    phones: [{ e164: '+381641112233', raw: '+381 64 111 2233' }],
  },
  {
    business: 'fasader-plus',
    source: 'gradjevinarstvo-rs',
    path: '/firma/fasader-plus',
    name: 'Fasader plus',
    cityId: 'novi-sad',
    municipalityId: 'novi-sad',
    cityRaw: 'Novi Sad',
    website: { url: 'https://fasaderplus.rs', domain: 'fasaderplus.rs' },
    phones: [{ e164: '+381641112233', raw: '064 111 2233' }],
  },
  {
    business: 'fasader-plus',
    source: 'own-website',
    path: 'https://fasaderplus.rs/kontakt',
    name: 'Fasader Plus',
    cityId: 'novi-sad',
    municipalityId: 'novi-sad',
    address: 'Futoška 42',
    email: 'info@fasaderplus.rs',
    website: { url: 'https://fasaderplus.rs', domain: 'fasaderplus.rs' },
    phones: [{ e164: '+381214445566', raw: '021/444-5566', landline: true }],
  },

  /* -- 2. Reached only by domain on one source, only by email on another --- */
  {
    business: 'termo-dom',
    source: 'gradjevinarstvo-rs',
    path: '/firma/termo-dom',
    name: 'Termo Dom',
    cityId: 'beograd',
    municipalityId: 'beograd',
    cityRaw: 'Beograd',
    description: 'Termoizolacija i stiropor fasade.',
    website: { url: 'https://termodom.rs', domain: 'termodom.rs' },
  },
  {
    business: 'termo-dom',
    source: 'own-website',
    path: 'https://termodom.rs/o-nama',
    name: 'Termo Dom d.o.o. Beograd',
    cityId: 'beograd',
    municipalityId: 'beograd',
    email: 'office@termodom.rs',
    website: { url: 'https://termodom.rs', domain: 'termodom.rs' },
    phones: [{ e164: '+381112223344', raw: '011/222-3344', landline: true }],
  },
  {
    business: 'termo-dom',
    source: 'oglasi-rs',
    path: '/oglas/termoizolacija-beograd-8811',
    name: 'TERMO DOM - povoljno!',
    cityId: 'beograd',
    municipalityId: 'beograd',
    email: 'office@termodom.rs',
  },

  /* -- 3. A sole trader on gmail, two directories -------------------------- */
  {
    business: 'petrovic-nis',
    source: 'portal-srbija',
    path: '/fasaderski-radovi-nis',
    name: 'Fasade Petrović',
    cityId: 'nis',
    municipalityId: 'nis',
    cityRaw: 'Niš',
    description: 'Fasaderski radovi, demit fasada, malterisanje.',
    phones: [{ e164: '+381631234567', raw: '063/123-4567' }],
    email: 'fasade.petrovic@gmail.com',
  },
  {
    business: 'petrovic-nis',
    source: 'oglasi-rs',
    path: '/oglas/fasaderski-radovi-nis-4412',
    name: 'Fasade Petrovic Nis',
    cityId: 'nis',
    municipalityId: 'nis',
    cityRaw: 'Nis',
    email: 'fasade.petrovic@gmail.com',
  },

  /* -- 4. The same name, a different city, a different business ------------ */
  {
    business: 'petrovic-novi-sad',
    source: 'navidiku-rs',
    path: '/firme/fasaderski-radovi/novi-sad/fasade-petrovic',
    name: 'Fasade Petrović',
    cityId: 'novi-sad',
    municipalityId: 'novi-sad',
    cityRaw: 'Novi Sad',
    phones: [{ e164: '+381649990011', raw: '064/999-0011' }],
  },

  /* -- 5. One business, one address, no shared contact at all -------------- */
  {
    business: 'markovic-kg',
    source: 'portal-srbija',
    path: '/fasaderski-radovi-kragujevac',
    name: 'Termo Fasade Marković',
    cityId: 'kragujevac',
    municipalityId: 'kragujevac',
    cityRaw: 'Kragujevac',
    address: 'Kralja Petra 12',
    description: 'Termo fasade i demit sistemi.',
    phones: [{ e164: '+381642223344', raw: '064/222-3344' }],
  },
  {
    business: 'markovic-kg',
    source: 'gradjevinarstvo-rs',
    path: '/firma/termofasade-markovic',
    name: 'Termofasade Markovic',
    cityId: 'kragujevac',
    municipalityId: 'kragujevac',
    address: 'Kralja Petra 12',
  },

  /* -- 6. A near-identical name in the same city — still two businesses ---- */
  {
    business: 'marko-kg',
    source: 'oglasi-rs',
    path: '/oglas/fasade-marko-kragujevac',
    name: 'Fasade Marko',
    cityId: 'kragujevac',
    municipalityId: 'kragujevac',
    cityRaw: 'Kragujevac',
    phones: [{ e164: '+381648887766', raw: '064/888-7766' }],
  },

  /* -- 7. Diacritics against ASCII, joined by an email --------------------- */
  {
    business: 'milic-cacak',
    source: 'portal-srbija',
    path: '/gradjevinski-materijal-cacak',
    name: 'Građevinski centar Milić',
    cityId: 'cacak',
    municipalityId: 'cacak',
    cityRaw: 'Čačak',
    description: 'Stovarište građevinskog materijala, prodaja stiropora.',
    email: 'milic@gcmilic.rs',
    phones: [{ e164: '+381321112233', raw: '032/111-2233', landline: true }],
  },
  {
    business: 'milic-cacak',
    source: 'navidiku-rs',
    path: '/firme/gradjevinski-materijal/cacak',
    name: 'Gradjevinski centar Milic',
    cityId: 'cacak',
    municipalityId: 'cacak',
    cityRaw: 'Cacak',
    email: 'milic@gcmilic.rs',
  },

  /* -- 8. A shared Facebook page corroborating a name match ---------------- */
  {
    business: 'gradnja-uzice',
    source: 'navidiku-rs',
    path: '/firme/stovarista/uzice',
    name: 'Stovarište Gradnja',
    cityId: 'uzice',
    municipalityId: 'uzice',
    cityRaw: 'Užice',
    description: 'Građevinsko stovarište, fasadni i izolacioni materijali.',
    facebook: 'https://www.facebook.com/stovaristegradnja',
  },
  {
    business: 'gradnja-uzice',
    source: 'facebook-pages',
    path: 'https://www.facebook.com/stovaristegradnja',
    name: 'Stovariste Gradnja d.o.o.',
    cityId: 'uzice',
    municipalityId: 'uzice',
    facebook: 'https://www.facebook.com/stovaristegradnja',
    phones: [{ e164: '+381311223344', raw: '031/122-3344', landline: true }],
  },

  /* -- 9. Two yards, two addresses, one phone ------------------------------ */
  {
    business: 'dunav-stovariste',
    source: 'portal-srbija',
    path: '/gradjevinsko-stovariste-beograd',
    name: 'Stovarište Dunav',
    cityId: 'beograd',
    municipalityId: 'beograd',
    cityRaw: 'Beograd',
    address: 'Bulevar oslobođenja 5',
    description: 'Prodaja građevinskog materijala i termoizolacionih ploča.',
    phones: [{ e164: '+381645556677', raw: '064/555-6677' }],
  },
  {
    business: 'dunav-stovariste',
    source: 'navidiku-rs',
    path: '/firme/stovarista/pancevo',
    name: 'Stovarište Dunav - stovarište Pančevo',
    cityId: 'pancevo',
    municipalityId: 'pancevo',
    cityRaw: 'Pančevo',
    address: 'Bavaništanski put 18',
    phones: [{ e164: '+381645556677', raw: '064 555 6677' }],
  },

  /* -- 10. A near-name that is a different stovarište ---------------------- */
  {
    business: 'beton-plus',
    source: 'gradjevinarstvo-rs',
    path: '/firma/stovariste-beton-plus',
    name: 'Stovariste Beton Plus',
    cityId: 'beograd',
    municipalityId: 'beograd',
    address: 'Pančevački put 40',
    description: 'Građevinski materijal na veliko i malo.',
    phones: [{ e164: '+381117776655', raw: '011/777-6655', landline: true }],
  },
  {
    business: 'beton',
    source: 'oglasi-rs',
    path: '/oglas/stovariste-beton-beograd',
    name: 'Stovariste Beton',
    cityId: 'beograd',
    municipalityId: 'beograd',
    address: 'Zrenjaninski put 2',
    phones: [{ e164: '+381113332211', raw: '011/333-2211', landline: true }],
  },

  /* -- 11. Two extensions of one switchboard, one business ----------------- */
  {
    business: 'izolacija-jovanovic',
    source: 'portal-srbija',
    path: '/termoizolacija-beograd',
    name: 'Izolacija Jovanović',
    cityId: 'beograd',
    municipalityId: 'beograd',
    cityRaw: 'Beograd',
    description: 'Termoizolacija, stiropor fasade, izolacija kuće.',
    phones: [{ e164: '+381114445501', raw: '011/444-5501', landline: true }],
  },
  {
    business: 'izolacija-jovanovic',
    source: 'gradjevinarstvo-rs',
    path: '/firma/izolacija-jovanovic',
    name: 'Izolacija Jovanovic',
    cityId: 'beograd',
    municipalityId: 'beograd',
    phones: [{ e164: '+381114445502', raw: '011/444-5502', landline: true }],
  },

  /* -- 12. Registered separately, one owner, one line ---------------------- */
  {
    business: 'komerc-gradnja',
    source: 'portal-srbija',
    path: '/gradjevinske-firme-cacak',
    name: 'Gradnja Komerc',
    cityId: 'cacak',
    municipalityId: 'cacak',
    cityRaw: 'Čačak',
    registrationNumber: '20123456',
    description: 'Završni građevinski radovi i fasade.',
    phones: [{ e164: '+381643334455', raw: '064/333-4455' }],
  },
  {
    business: 'komerc-trade',
    source: 'navidiku-rs',
    path: '/firme/gradjevina/cacak',
    name: 'Gradnja Komerc Trade',
    cityId: 'cacak',
    municipalityId: 'cacak',
    registrationNumber: '21999888',
    phones: [{ e164: '+381643334455', raw: '064 333 4455' }],
  },

  /* -- 13. Five unrelated companies on one listing service's switchboard --- */
  {
    business: 'kc-fasade-jovanovic',
    source: 'oglasi-rs',
    path: '/oglas/fasade-jovanovic-11',
    name: 'Fasade Jovanović',
    cityId: 'beograd',
    municipalityId: 'beograd',
    description: 'Fasaderski radovi.',
    phones: [{ e164: '+381119998800', raw: '011/999-8800', landline: true }],
  },
  {
    business: 'kc-izolacija-nikolic',
    source: 'oglasi-rs',
    path: '/oglas/izolacija-nikolic-12',
    name: 'Izolacija Nikolić',
    cityId: 'beograd',
    municipalityId: 'beograd',
    description: 'Termoizolacija objekata.',
    phones: [{ e164: '+381119998800', raw: '011/999-8800', landline: true }],
  },
  {
    business: 'kc-termo-sistem',
    source: 'oglasi-rs',
    path: '/oglas/termo-sistem-13',
    name: 'Termo Sistem',
    cityId: 'beograd',
    municipalityId: 'beograd',
    description: 'Demit fasade.',
    phones: [{ e164: '+381119998800', raw: '011/999-8800', landline: true }],
  },
  {
    business: 'kc-zoran',
    source: 'oglasi-rs',
    path: '/oglas/fasaderski-radovi-zoran-14',
    name: 'Fasaderski radovi Zoran',
    cityId: 'beograd',
    municipalityId: 'beograd',
    description: 'Majstori za fasadu.',
    phones: [{ e164: '+381119998800', raw: '011/999-8800', landline: true }],
  },
  {
    business: 'kc-stovariste-sava',
    source: 'oglasi-rs',
    path: '/oglas/stovariste-sava-15',
    name: 'Stovarište Sava',
    cityId: 'beograd',
    municipalityId: 'beograd',
    description: 'Građevinski materijal.',
    phones: [{ e164: '+381119998800', raw: '011/999-8800', landline: true }],
  },

  /* -- 14. A directory printing its own address on every entry ------------- */
  {
    business: 'subotica-fasade',
    source: 'portal-srbija',
    path: '/fasaderski-radovi-subotica',
    name: 'Fasade Sever',
    cityId: 'subotica',
    municipalityId: 'subotica',
    cityRaw: 'Subotica',
    description: 'Fasaderski radovi i termoizolacija.',
    email: 'kontakt@portal-srbija.com',
    phones: [{ e164: '+381246661122', raw: '024/666-1122', landline: true }],
  },
  {
    business: 'subotica-stovariste',
    source: 'portal-srbija',
    path: '/gradjevinski-materijal-subotica',
    name: 'Stovarište Palić',
    cityId: 'subotica',
    municipalityId: 'subotica',
    cityRaw: 'Subotica',
    description: 'Prodaja stiropora i izolacionih materijala.',
    email: 'kontakt@portal-srbija.com',
    phones: [{ e164: '+381246663344', raw: '024/666-3344', landline: true }],
  },

  /* -- 15. Singletons, one record each ------------------------------------- */
  {
    business: 'leskovac-fasade',
    source: 'navidiku-rs',
    path: '/firme/fasaderski-radovi/leskovac',
    name: 'Fasade Jug',
    cityId: 'leskovac',
    municipalityId: 'leskovac',
    cityRaw: 'Leskovac',
    description: 'Demit fasada, termo fasada, izolacija.',
    phones: [{ e164: '+381641230001', raw: '064/123-0001' }],
  },
  {
    business: 'kraljevo-stovariste',
    source: 'portal-srbija',
    path: '/gradjevinsko-stovariste-kraljevo',
    name: 'Stovarište Ibar',
    cityId: 'kraljevo',
    municipalityId: 'kraljevo',
    cityRaw: 'Kraljevo',
    description: 'Građevinsko stovarište, fasadni materijal.',
    phones: [{ e164: '+381641230002', raw: '064/123-0002' }],
  },
  {
    business: 'zrenjanin-izolacija',
    source: 'gradjevinarstvo-rs',
    path: '/firma/izolacija-banat',
    name: 'Izolacija Banat',
    cityId: 'zrenjanin',
    municipalityId: 'zrenjanin',
    cityRaw: 'Zrenjanin',
    description: 'Termoizolacioni materijali i stiropor.',
    phones: [{ e164: '+381641230003', raw: '064/123-0003' }],
  },
  {
    business: 'uzice-majstori',
    source: 'oglasi-rs',
    path: '/oglas/majstori-za-fasadu-uzice',
    name: 'Majstori za fasadu Zlatibor',
    cityId: 'uzice',
    municipalityId: 'uzice',
    cityRaw: 'Užice',
    description: 'Molersko fasaderski radovi.',
    phones: [{ e164: '+381641230004', raw: '064/123-0004' }],
  },
  {
    business: 'nis-stovariste',
    source: 'navidiku-rs',
    path: '/firme/stovarista/nis',
    name: 'Stovarište Nišava',
    cityId: 'nis',
    municipalityId: 'nis',
    cityRaw: 'Niš',
    description: 'Građevinski materijal, prodaja stiropora.',
    phones: [{ e164: '+381641230005', raw: '064/123-0005' }],
  },
  {
    business: 'beograd-demit',
    source: 'facebook-pages',
    path: 'https://www.facebook.com/demitfasadebg',
    name: 'Demit Fasade BG',
    cityId: 'beograd',
    municipalityId: 'beograd',
    description: 'Demit fasade i stiropor fasade, Beograd.',
    facebook: 'https://www.facebook.com/demitfasadebg',
    phones: [{ e164: '+381641230006', raw: '064/123-0006' }],
  },
  {
    business: 'novi-sad-stovariste',
    source: 'gradjevinarstvo-rs',
    path: '/firma/stovariste-bacs',
    name: 'Stovarište Bačka',
    cityId: 'novi-sad',
    municipalityId: 'novi-sad',
    cityRaw: 'Novi Sad',
    description: 'Fasadni materijal i termoizolacija na stovarištu.',
    phones: [{ e164: '+381641230007', raw: '064/123-0007' }],
  },
  {
    business: 'kragujevac-stovariste',
    source: 'portal-srbija',
    path: '/gradjevinski-materijal-kragujevac',
    name: 'Šumadija Gradnja',
    cityId: 'kragujevac',
    municipalityId: 'kragujevac',
    cityRaw: 'Kragujevac',
    description: 'Građevinsko stovarište i prodaja izolacionih materijala.',
    phones: [{ e164: '+381641230008', raw: '064/123-0008' }],
  },
  {
    business: 'cacak-fasade',
    source: 'oglasi-rs',
    path: '/oglas/fasade-morava-cacak',
    name: 'Fasade Morava',
    cityId: 'cacak',
    municipalityId: 'cacak',
    cityRaw: 'Čačak',
    description: 'Izrada fasade, termo fasada.',
    phones: [{ e164: '+381641230009', raw: '064/123-0009' }],
  },
  {
    business: 'pancevo-izolacija',
    source: 'navidiku-rs',
    path: '/firme/termoizolacija/pancevo',
    name: 'Izolacija Tamiš',
    cityId: 'pancevo',
    municipalityId: 'pancevo',
    cityRaw: 'Pančevo',
    description: 'Termoizolacija i izolacija kuće.',
    phones: [{ e164: '+381641230010', raw: '064/123-0010' }],
  },
  {
    business: 'subotica-majstor',
    source: 'oglasi-rs',
    path: '/oglas/fasader-subotica',
    name: 'Fasader Sever Kiš',
    cityId: 'subotica',
    municipalityId: 'subotica',
    cityRaw: 'Subotica',
    description: 'Fasaderske usluge, stiropor fasada.',
    phones: [{ e164: '+381641230011', raw: '064/123-0011' }],
  },
  {
    business: 'kraljevo-fasade',
    source: 'gradjevinarstvo-rs',
    path: '/firma/fasade-rudnik',
    name: 'Fasade Rudnik',
    cityId: 'kraljevo',
    municipalityId: 'kraljevo',
    description: 'Fasaderski radovi i završni građevinski radovi.',
    phones: [{ e164: '+381641230012', raw: '064/123-0012' }],
  },
  {
    business: 'leskovac-stovariste',
    source: 'portal-srbija',
    path: '/gradjevinsko-stovariste-leskovac',
    name: 'Stovarište Veternica',
    cityId: 'leskovac',
    municipalityId: 'leskovac',
    description: 'Građevinski materijal i fasadni sistemi.',
    phones: [{ e164: '+381641230013', raw: '064/123-0013' }],
  },
  {
    business: 'zrenjanin-fasade',
    source: 'oglasi-rs',
    path: '/oglas/fasade-begej-zrenjanin',
    name: 'Fasade Begej',
    cityId: 'zrenjanin',
    municipalityId: 'zrenjanin',
    description: 'Termo fasada i demit fasada.',
    phones: [{ e164: '+381641230014', raw: '064/123-0014' }],
  },
  {
    business: 'nis-fasade-dva',
    source: 'facebook-pages',
    path: 'https://www.facebook.com/fasadenisplus',
    name: 'Fasade Niš Plus',
    cityId: 'nis',
    municipalityId: 'nis',
    description: 'Fasaderski radovi u Nišu.',
    facebook: 'https://www.facebook.com/fasadenisplus',
    phones: [{ e164: '+381641230015', raw: '064/123-0015' }],
  },
  {
    business: 'uzice-stovariste',
    source: 'portal-srbija',
    path: '/gradjevinski-materijal-uzice',
    name: 'Stovarište Zlatibor Gradnja',
    cityId: 'uzice',
    municipalityId: 'uzice',
    description: 'Stovarište, prodaja stiropora i fasadnog materijala.',
    phones: [{ e164: '+381641230016', raw: '064/123-0016' }],
  },
  {
    business: 'beograd-fasade-tri',
    source: 'gradjevinarstvo-rs',
    path: '/firma/fasade-vozdovac',
    name: 'Fasade Voždovac',
    cityId: 'beograd',
    municipalityId: 'beograd',
    description: 'Molersko fasaderski radovi, demit fasada.',
    phones: [{ e164: '+381641230017', raw: '064/123-0017' }],
  },
  {
    business: 'novi-sad-fasade-dva',
    source: 'oglasi-rs',
    path: '/oglas/fasade-liman-novi-sad',
    name: 'Fasade Liman',
    cityId: 'novi-sad',
    municipalityId: 'novi-sad',
    description: 'Izrada fasade i termoizolacija.',
    phones: [{ e164: '+381641230018', raw: '064/123-0018' }],
  },
  {
    business: 'cacak-stovariste',
    source: 'navidiku-rs',
    path: '/firme/stovarista/cacak',
    name: 'Stovarište Zapadna Morava',
    cityId: 'cacak',
    municipalityId: 'cacak',
    description: 'Građevinsko stovarište i izolacioni materijali.',
    phones: [{ e164: '+381641230019', raw: '064/123-0019' }],
  },
  {
    business: 'pancevo-stovariste',
    source: 'gradjevinarstvo-rs',
    path: '/firma/stovariste-pancevo-gradnja',
    name: 'Pančevo Gradnja Stovarište',
    cityId: 'pancevo',
    municipalityId: 'pancevo',
    description: 'Prodaja građevinskog i fasadnog materijala.',
    phones: [{ e164: '+381641230020', raw: '064/123-0020' }],
  },
  {
    business: 'kragujevac-fasade-dva',
    source: 'oglasi-rs',
    path: '/oglas/fasade-lepenica',
    name: 'Fasade Lepenica',
    cityId: 'kragujevac',
    municipalityId: 'kragujevac',
    description: 'Fasaderski radovi, izolacija kuće.',
    phones: [{ e164: '+381641230021', raw: '064/123-0021' }],
  },
  {
    business: 'leskovac-izolacija',
    source: 'navidiku-rs',
    path: '/firme/termoizolacija/leskovac',
    name: 'Izolacija Jug Komerc',
    cityId: 'leskovac',
    municipalityId: 'leskovac',
    description: 'Termoizolacioni materijal i stiropor.',
    phones: [{ e164: '+381641230022', raw: '064/123-0022' }],
  },
];

/* -------------------------------------------------------------------------- */
/* Turning a fixture into what the pipeline actually receives                 */
/* -------------------------------------------------------------------------- */

const SOURCE_HOST: Record<FixtureSourceId, string> = {
  'portal-srbija': 'https://www.portal-srbija.com',
  'navidiku-rs': 'https://www.navidiku.rs',
  'gradjevinarstvo-rs': 'https://www.gradjevinarstvo.rs',
  'oglasi-rs': 'https://www.oglasi.rs',
  'facebook-pages': 'https://www.facebook.com',
  'own-website': '',
};

export function fixtureProvenance(record: FixtureRecord, seenAt: Date): Provenance {
  const sourceUrl = record.path.startsWith('http')
    ? record.path
    : `${SOURCE_HOST[record.source]}${record.path}`;
  return { sourceId: record.source, sourceUrl, seenAt };
}

export function fixtureInput(record: FixtureRecord): LeadInput {
  const name = normalizeCompanyName(record.name);
  return {
    name: record.name,
    nameNormalized: name.ascii,
    cityId: record.cityId ?? null,
    municipalityId: record.municipalityId ?? null,
    cityRaw: record.cityRaw ?? null,
    address: record.address ?? null,
    addressNormalized: record.address?.toLowerCase() ?? null,
    description: record.description ?? null,
    registrationNumber: record.registrationNumber ?? null,
    phones: (record.phones ?? []).map((phone) => ({
      e164: phone.e164,
      raw: phone.raw,
      type: phone.landline === true ? ('landline' as const) : ('mobile' as const),
    })),
    contacts: [
      ...(record.email == null ? [] : [{ kind: 'email' as const, value: record.email }]),
      ...(record.website == null
        ? []
        : [
            {
              kind: 'website' as const,
              value: record.website.url,
              domain: record.website.domain,
            },
          ]),
      ...(record.facebook == null ? [] : [{ kind: 'facebook' as const, value: record.facebook }]),
    ],
  };
}

/** The ground truth: how many businesses the 54 records describe. */
export function expectedBusinessCount(): number {
  return new Set(FIXTURES.map((record) => record.business)).size;
}

/** Businesses described by more than one record — the duplicates to be found. */
export function duplicatedBusinesses(): readonly string[] {
  const counts = new Map<string, number>();
  for (const record of FIXTURES) {
    counts.set(record.business, (counts.get(record.business) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([business]) => business);
}
