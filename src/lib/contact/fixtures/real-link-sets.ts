/**
 * Link sets captured from real Serbian listing pages on 2026-08-20.
 *
 * Every `links` array below is what the anchors on that page actually
 * contained — hrefs and anchor text, in document order, with the page's own
 * internal navigation removed — fetched once over HTTP for this test suite.
 * Nothing here is invented: the malformed `target="_blank"` inside an href,
 * the space in `http:// www.vns.rs`, the ten foreign editions in a footer and
 * the "web dizajn" credit are all as published.
 *
 * They exist so the extractors are tested against the mess they will actually
 * meet rather than against a tidy example.
 */

export interface RealLinkSet {
  /** Fixture id, `<source>-<listing>`. */
  readonly id: string;
  readonly sourceUrl: string;
  /** The host the page was served from — what the extractors take as `sourceDomain`. */
  readonly sourceDomain: string;
  /** ISO date the page was fetched. */
  readonly capturedAt: string;
  /** What makes this page worth a fixture. */
  readonly note: string;
  readonly links: ReadonlyArray<{ readonly href: string; readonly text?: string }>;
}

export const REAL_LINK_SETS: readonly RealLinkSet[] = [
  {
    id: '011info-bimax',
    sourceUrl: 'https://www.011info.com/izolacija-hidroizolacija-termoizolacija/bimax-doo',
    sourceDomain: 'www.011info.com',
    capturedAt: '2026-08-20',
    note: 'A complete listing: mailto, website, Maps navigation link, portal socials.',
    links: [
      { href: 'https://www.381info.com/posao', text: 'Tražite posao?' },
      { href: 'https://www.facebook.com/011info/' },
      { href: 'https://www.instagram.com/011info/' },
      { href: 'https://twitter.com/bgvodic?lang=en' },
      { href: 'https://www.linkedin.com/company/011info-com/' },
      { href: 'https://www.youtube.com/@beogradskivodic' },
      { href: 'https://www.tiktok.com/@011info' },
      { href: 'mailto:bimax@bimax.rs', text: 'bimax@bimax.rs' },
      { href: 'https://www.bimax.rs', text: 'www.bimax.rs' },
      {
        href: 'https://www.google.com/maps/dir/?api=1&destination=44.848134,20.394314&travelmode=driving&lang=sr',
        text: 'Navigacija',
      },
      { href: 'https://www.381info.com/', text: '381info.com' },
    ],
  },
  {
    id: 'aladin-stovarista',
    sourceUrl: 'https://srbija.aladin.info/gradjevinarstvo/gradjevinski-materijal-i-stovarista/',
    sourceDomain: 'srbija.aladin.info',
    capturedAt: '2026-08-20',
    note: 'Category page: one "website" anchor per listed company.',
    links: [
      { href: 'https://www.aladin.info/', text: 'Aladin ®' },
      { href: 'https://www.aladin.info/accounts/reg.php?reg=no', text: 'Registrovanje' },
      { href: 'https://www.aladin.info/accounts/user.php?reg=1', text: 'Ulazak' },
      { href: 'https://tv.aladin.info/', text: 'TV Program' },
      { href: 'https://tv.aladin.info/film/', text: 'Sadržaj filmova' },
      { href: 'https://tv.aladin.info/live', text: 'Trenutno na programu' },
      { href: 'https://www.aladin.info/vremenska-prognoza/', text: 'Vreme' },
      { href: 'https://www.aladin.info/i/kontakt', text: 'Kontakt' },
      { href: 'https://www.aladin.info/accounts/user.php?reg=1&ref=srbija', text: 'Moja firma' },
      {
        href: 'https://www.aladin.info/accounts/user.php?reg=no&ref=srbija',
        text: 'Registrovanje',
      },
      {
        href: 'https://www.aladin.info/i/adresar-predstavljanje-firme-3',
        text: 'Sponzor kategorije',
      },
      { href: 'http://www.tricomdoo.com', text: 'website' },
      { href: 'http://www.kodiko.rs', text: 'website' },
      { href: 'https://www.leyde.com/web/', text: 'website' },
      { href: 'https://kapakrcevac.com', text: 'website' },
      { href: 'https://jugosistem.rs', text: 'website' },
    ],
  },
  {
    id: 'austrotherm-distributeri',
    sourceUrl: 'https://www.austrotherm.rs/distributeri',
    sourceDomain: 'www.austrotherm.rs',
    capturedAt: '2026-08-20',
    note: 'A manufacturer’s distributor page, scraped as a source of store leads.',
    links: [
      { href: 'http://www.austrotherm.at', text: 'Österreich' },
      { href: 'http://www.austrotherm.de', text: 'Deutschland' },
      { href: 'http://www.austrotherm.cz', text: 'Česká republika' },
      { href: 'http://www.austrotherm.pl', text: 'Polska' },
      { href: 'http://www.austrotherm.sk', text: 'Slovenská Republika' },
      { href: 'http://www.austrotherm.hu', text: 'Magyarország' },
      { href: 'http://www.austrotherm.ro', text: 'Romania' },
      { href: 'http://www.austrotherm.ba', text: 'Bosna i Hercegovina' },
      { href: 'http://www.austrotherm.hr', text: 'Hrvatska' },
      { href: 'http://www.austrotherm.bg', text: 'България' },
      { href: 'http://www.austrotherm.com.tr', text: 'Türkiye' },
      {
        href: 'http://www.facebook.com/sharer.php?u=https%3A%2F%2Fwww.austrotherm.rs%2Fdistributeri',
        text: 'Facebook',
      },
      {
        href: 'https://x.com/intent/tweet?via=austrotherm&url=https%3A%2F%2Fwww.austrotherm.rs%2Fdistributeri',
        text: 'X',
      },
      { href: 'mailto:?body=https%3A%2F%2Fwww.austrotherm.rs%2Fdistributeri', text: 'E-Mail' },
      { href: 'https://www.facebook.com/Austrotherm.rs/' },
      { href: 'https://www.linkedin.com/company/austrotherm-srbija' },
    ],
  },
  {
    id: 'biznisgroup-gradis',
    sourceUrl:
      'https://www.biznisgroup.rs/gra%C4%91evinarstvo/stovariste-gradevinskog-materijala-gradis-novi-pazar/',
    sourceDomain: 'www.biznisgroup.rs',
    capturedAt: '2026-08-20',
    note: 'Cloudflare-obfuscated email, share widgets, and a wall of unrelated advertiser links.',
    links: [
      {
        href: '/cdn-cgi/l/email-protection#5a65292f38303f392e67092e352c3b28337f196f7f1b6b2e3f711d283b7f196e7f636b3f2c33342931353d71173b2e3f2833303b363b711d283b3e33297114352c33710a3b203b287c3b372a6138353e2367322e2e2a296075752d2d2d743833203433293d28352f2a742829753d283b9ecb3f2c33343b28292e2c3575292e352c3b2833292e3f773d283b3e3f2c33342931353d77373b2e3f2833303b363b773d283b3e33297734352c33772a3b203b2875',
      },
      {
        href: 'https://www.facebook.com/share.php?u=https://www.biznisgroup.rs/građevinarstvo/stovariste-gradevinskog-materijala-gradis-novi-pazar/&title=Stovarište%20Građevinskog%20Materijala%20Gradis%20Novi%20Pazar#sthash.BUkY1jCE.dpuf',
      },
      {
        href: 'https://plus.google.com/share?url=https://www.biznisgroup.rs/građevinarstvo/stovariste-gradevinskog-materijala-gradis-novi-pazar/',
      },
      {
        href: 'https://twitter.com/home?status=Stovarište%20Građevinskog%20Materijala%20Gradis%20Novi%20Pazar+https://www.biznisgroup.rs/građevinarstvo/stovariste-gradevinskog-materijala-gradis-novi-pazar/#sthash.BUkY1jCE.dpuf',
      },
      { href: 'https://maps.google.com?daddr=43.148506,20.52075960000002', text: 'Directions' },
      { href: 'http://www.prvitaxi.com' },
      { href: 'http://www.nis-rentacar.com' },
      { href: 'http://viladinka.rs' },
      { href: 'https://www.biznisgroup.com/Automobili/lux-taksi-eko-taksi-nis/' },
      { href: 'http://decorlife.rs/' },
      { href: 'https://www.stefanon.rs/' },
      { href: 'http://ana.relaxkids.rs/' },
      { href: 'http://www.vilajelena-zlatibor.com/' },
      { href: '/cdn-cgi/l/email-protection', text: '[email protected]' },
      { href: 'https://www.facebook.com/biznisgroup.rs/', text: 'facebook' },
      { href: 'https://www.instagram.com/biznis_katalog_evrope/?hl=sr', text: 'instagram' },
    ],
  },
  {
    id: 'daibau-rading',
    sourceUrl: 'https://www.daibau.rs/izvodjac/rading_doo_beograd',
    sourceDomain: 'www.daibau.rs',
    capturedAt: '2026-08-20',
    note: 'Footer links the portal’s ten foreign editions.',
    links: [
      {
        href: 'https://www.daibau.rs/cdn-cgi/content?id=wOcO0.cfKjVkpAvJK9o20WWF6FJj0hCKuZ6N6dIxrAw-1787180580.2421627-1.2.1.1-dBB.5gAdVtKKgQyafAmsB5MLFXiz66843gx3XGSyfDHAzo5dWEv3DDixEexZN2RK',
      },
      { href: 'https://www.daibau.de', text: 'DE: daibau.de' },
      { href: 'https://www.daibau.at', text: 'AT: daibau.at' },
      { href: 'https://www.daibau.ch', text: 'CH: daibau.ch' },
      { href: 'https://www.daibau.pl', text: 'PL: daibau.pl' },
      { href: 'https://www.daibau.cz', text: 'CZ: daibau.cz' },
      { href: 'https://www.daibau.sk', text: 'SK: daibau.sk' },
      { href: 'https://www.mojmojster.net', text: 'SI: mojmojster.net' },
      { href: 'https://www.emajstor.hr', text: 'HR: emajstor.hr' },
      { href: 'https://www.daibau.hu', text: 'HU: daibau.hu' },
      { href: 'https://www.daibau.ro', text: 'RO: daibau.ro' },
      { href: 'https://www.daibau.bg', text: 'BG: daibau.bg' },
    ],
  },
  {
    id: 'gradjevinarstvo-austrotherm',
    sourceUrl: 'https://www.gradjevinarstvo.rs/firme/2165/austrotherm',
    sourceDomain: 'www.gradjevinarstvo.rs',
    capturedAt: '2026-08-20',
    note: 'The company site as anchor text, next to a banner with campaign parameters.',
    links: [
      {
        href: 'https://infonetgroup.com/?utm_source=gradjevinarstvo&utm_medium=baner468x60&utm_campaign=GR_H_baner',
      },
      { href: 'https://www.pinterest.com/gradjevinarstvo/' },
      { href: 'https://www.YouTube.com/GradjevinarstvoVideo' },
      { href: 'https://www.twitter.com/gradjevinarstvo' },
      { href: 'https://www.facebook.com/gradjevinarstvo' },
      { href: 'https://www.austrotherm.rs', text: 'www.austrotherm.rs' },
      {
        href: 'mailto:?subject=gradjevinarstvo.rs - AUSTROTHERM&body=https://www.gradjevinarstvo.rs/firme/2165/austrotherm',
        text: 'Pošaljite e-mail prijatelju',
      },
    ],
  },
  {
    id: 'gradjevinarstvo-popovic',
    sourceUrl: 'https://www.gradjevinarstvo.rs/firme/5143/popovic',
    sourceDomain: 'www.gradjevinarstvo.rs',
    capturedAt: '2026-08-20',
    note: 'A company with no website — only the portal’s own banners and socials.',
    links: [
      {
        href: 'https://infonetgroup.com/?utm_source=gradjevinarstvo&utm_medium=baner468x60&utm_campaign=GR_H_baner',
      },
      { href: 'https://www.pinterest.com/gradjevinarstvo/' },
      { href: 'https://www.YouTube.com/GradjevinarstvoVideo' },
      { href: 'https://www.twitter.com/gradjevinarstvo' },
      { href: 'https://www.facebook.com/gradjevinarstvo' },
      {
        href: 'mailto:?subject=gradjevinarstvo.rs - POPOVIĆ&body=',
        text: 'Pošaljite e-mail prijatelju',
      },
      {
        href: 'https://infonetgroup.com/?utm_source=gradjevinarstvo&utm_medium=GR_brendiranje&utm_campaign=GR_brending',
      },
    ],
  },
  {
    id: 'gradjevinskefirme-prima',
    sourceUrl: 'https://www.gradjevinskefirme.cu.rs/beograd/012-prima-doo-beograd/',
    sourceDomain: 'www.gradjevinskefirme.cu.rs',
    capturedAt: '2026-08-20',
    note: 'Footer full of the operator’s other sites and the web agency that built it.',
    links: [
      {
        href: 'http://oglasi.cc/kategorija/gradjevinarstvo/',
        text: 'Gradjevinarstvo" > Gradjevinarstvo" width="140" height="60"',
      },
      { href: 'http://nekretnine.cc' },
      { href: 'http://www.nekretninesokobanja.com' },
      { href: 'http://www.gipsart.co.rs/' },
      { href: 'http://cu.rs/reklamiranje.php' },
      { href: 'http://cu.rs/gps-koordinate.php', text: 'GPS koordinate' },
      { href: 'http://beograd.besplatnioglasi.in.rs/', text: 'BEOGRAD OGLASI' },
      { href: 'http://postanskibroj.cu.rs/srbija/beograd', text: 'Poštanski broj BEOGRAD' },
      { href: 'http://pozivnibroj.cu.rs/srbija/beograd', text: 'Pozivni broj BEOGRAD' },
      { href: 'http://beograd.mapa.in.rs/', text: 'BEOGRAD mapa' },
      { href: 'http://gradjevinskimaterijal.cu.rs', text: 'Gradjevinski materijal' },
      { href: 'http://alati.cu.rs', text: 'Alati' },
      { href: 'http://namestaj.cu.rs/', text: 'Nameštaj' },
      { href: 'http://www.webharmony.biz' },
      { href: 'http://www.web-dizajn.eu/', text: 'Web dizajn' },
      { href: 'http://www.izradasajta.net/', text: 'Izrada sajta' },
    ],
  },
  {
    id: 'majstorimajstori-fasada',
    sourceUrl:
      'https://www.majstorimajstori.com/gradjevinski-radovi/fasader/majstor-za-fasadu-fasade-beograd-i1',
    sourceDomain: 'www.majstorimajstori.com',
    capturedAt: '2026-08-20',
    note: 'Classified ad: share widgets and a Maps directions link to a typed address.',
    links: [
      {
        href: 'https://maps.google.com/maps?daddr=Beograd%2C+Beograd%2C+38',
        text: 'Beograd, Beograd, 38',
      },
      {
        href: 'https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fwww.majstorimajstori.com%2Fgradjevinski-radovi%2Ffasader%2Fmajstor-za-fasadu-fasade-beograd-i1',
      },
      {
        href: 'https://twitter.com/intent/tweet?text=Majstor+za+fasadu+-+Fasade+Beograd&url=https%3A%2F%2Fwww.majstorimajstori.com%2Fgradjevinski-radovi%2Ffasader%2Fmajstor-za-fasadu-fasade-beograd-i1',
      },
      {
        href: 'https://pinterest.com/pin/create/button/?url=https%3A%2F%2Fwww.majstorimajstori.com%2Fgradjevinski-radovi%2Ffasader%2Fmajstor-za-fasadu-fasade-beograd-i1&media=https%3A%2F%2Fwww.majstorimajstori.com%2Foc-content%2Fuploads%2F0%2F1.webp&description=Majstor za fasadu - Fasade Beograd',
      },
      {
        href: 'https://maps.google.com/maps?daddr=11050%2C+Svi+Delovi+Grada%2C+Beograd%2C+Beograd%2C+Republika+Srbija',
        text: 'Prikaži lokaciju na Google mapi',
      },
      {
        href: 'https://pinterest.com/pin/create/button/?url=https%3A%2F%2Fwww.majstorimajstori.com%2Fgradjevinski-radovi%2Ffasader%2Fmajstor-za-fasadu-fasade-beograd-i1&media=https://www.majstorimajstori.com/oc-content/themes/delta/images/logo.jpg&description=',
      },
      {
        href: 'https://twitter.com/home?status=https%3A%2F%2Fwww.majstorimajstori.com%2Fgradjevinski-radovi%2Ffasader%2Fmajstor-za-fasadu-fasade-beograd-i1%20-%20your%20classifieds',
      },
      {
        href: 'https://www.linkedin.com/shareArticle?mini=true&url=https%3A%2F%2Fwww.majstorimajstori.com%2Fgradjevinski-radovi%2Ffasader%2Fmajstor-za-fasadu-fasade-beograd-i1&title=My%20classifieds&summary=&source=',
      },
    ],
  },
  {
    id: 'metalac-stores',
    sourceUrl: 'https://www.market.metalac.com/store-locations',
    sourceDomain: 'www.market.metalac.com',
    capturedAt: '2026-08-20',
    note: 'Store locator of a retail chain; the Maps link carries a full feature id.',
    links: [
      { href: 'mailto:kontakt@market.metalac.com', text: 'kontakt@market.metalac.com' },
      { href: 'https://www.facebook.com/metalacsrb' },
      { href: 'https://www.instagram.com/metalacad' },
      { href: 'https://www.youtube.com/user/MetalacPosudje' },
      { href: 'https://x.com/metalacad' },
      {
        href: 'https://www.google.com/maps/place/Kneza+Aleksandra+212,+Gornji+Milanovac+32300/@44.0378172,20.4781858,17z/data=!3m1!4b1!4m5!3m4!1s0x475741d73a50b41f:0xf0bc77c82a052c67!8m2!3d44.0378172!4d20.4803746',
        text: '32300 Gornji Milanovac',
      },
      { href: 'https://smartweb.rs/' },
      { href: 'https://www.bancaintesa.rs' },
    ],
  },
  {
    id: 'mirandre-domino',
    sourceUrl: 'https://www.mirandre.com/gradjevinski-centar-domino',
    sourceDomain: 'www.mirandre.com',
    capturedAt: '2026-08-20',
    note: 'No outbound link at all — the listing carries a phone and an address only.',
    links: [],
  },
  {
    id: 'nadjimajstora-srdjan',
    sourceUrl: 'https://www.nadjimajstora.rs/gradjevinski-radovi/fasader/srdjan-todic--2298.htm',
    sourceDomain: 'www.nadjimajstora.rs',
    capturedAt: '2026-08-20',
    note: 'A tradesman profile: one link, and it is the portal’s advertiser.',
    links: [{ href: 'https://www.mida.rs', text: 'MIDA' }],
  },
  {
    id: 'navidiku-vasfasader',
    sourceUrl:
      'https://www.navidiku.rs/firme/izvodjenje-radova-beograd/vas-fasader-izgradnja-objekata',
    sourceDomain: 'www.navidiku.rs',
    capturedAt: '2026-08-20',
    note: 'The business site is behind the anchor text "našem sajtu".',
    links: [
      { href: 'https://mojafirma.navidiku.rs/', text: 'Moja Firma' },
      { href: 'https://vasfasader.rs/', text: 'našem sajtu' },
      {
        href: 'https://www.google.com/maps/dir/?api=1&destination=44.813011871389214%2C20.469785996150737',
        text: 'Kako do nas? Putanja',
      },
      { href: 'https://www.facebook.com/Navidiku.rs' },
      { href: 'https://twitter.com/NavidikuRs' },
      { href: 'https://www.instagram.com/navidiku.rs/' },
      { href: 'https://www.youtube.com/channel/UCOlTWc3cn-osKKA_M_KZmoQ' },
      { href: 'https://www.linkedin.com/company/navidiku-rs' },
    ],
  },
  {
    id: 'portal-srbija-stovarista-bg',
    sourceUrl: 'https://www.portal-srbija.com/stovarista-beograd',
    sourceDomain: 'www.portal-srbija.com',
    capturedAt: '2026-08-20',
    note: 'Category page; every row prints the company site as its own anchor text.',
    links: [
      { href: 'https://www.ostrog.rs/', text: 'https://www.ostrog.rs/' },
      { href: 'http://www.ucpartizan.com', text: 'www.ucpartizan.com' },
      { href: 'https://www.gradistekomerc.com/', text: 'https://www.gradistekomerc.com/' },
      { href: 'http://www.dzavic.com', text: 'www.dzavic.com' },
      { href: 'https://stovariste-nuto.com/', text: 'https://stovariste-nuto.com/' },
      { href: 'http://www.srmagroup.com', text: 'www.srmagroup.com' },
      { href: 'http://www.termodom.rs', text: 'www.termodom.rs' },
      { href: 'http://www.dominosrbija.com', text: 'www.dominosrbija.com' },
      { href: 'http://www.niksacomerc.com', text: 'www.niksacomerc.com' },
      { href: 'http://www.bojtasprodukt.rs', text: 'www.bojtasprodukt.rs' },
      { href: 'http://www.toplica.co.rs', text: 'www.toplica.co.rs' },
      { href: 'http://www.sevotim.com', text: 'www.sevotim.com' },
      { href: 'http://www.bramac.rs', text: 'www.bramac.rs' },
      { href: 'http://www.spalex.rs', text: 'www.spalex.rs' },
      { href: 'http://www.icb.rs', text: 'www.icb.rs' },
      { href: 'http://www.neimarv.rs', text: 'www.neimarv.rs' },
    ],
  },
  {
    id: 'poslovnikontakt-dragomir',
    sourceUrl: 'https://poslovnikontakt.com/firma/moler-dragomir/',
    sourceDomain: 'poslovnikontakt.com',
    capturedAt: '2026-08-20',
    note: 'A malformed Facebook href with the closing quote missing.',
    links: [
      {
        href: 'https://www.facebook.com/pages/Agencija-Poslovni-kontakt/984748621542308?ref=hl/  target="_blank"',
      },
      { href: 'https://www.instagram.com/apartmani_zlatibor_smestaj/' },
      { href: 'https://twitter.com/share', text: 'Tweet' },
      { href: 'https://bookaweb.com/sr', text: 'Bookaweb travel sajt' },
      { href: 'https://www.vrnjackabanjasmestaj.rs/', text: 'Vrnjačka Banja – Turistički portal' },
      { href: 'https://www.kopaoniksmestaj.rs/', text: 'Kopaonik smeštaj' },
      { href: 'https://www.apartmanivikendice.com/', text: 'Apartmani & Vikendice' },
      { href: 'https://www.bgautentik.com/', text: 'Poslovni adresar Beograda' },
      { href: 'https://www.biznet.rs/', text: 'Mobilni telefoni, dronovi, bela tehnika' },
      { href: 'http://www.smernica.com', text: 'Sajtovi' },
    ],
  },
  {
    id: 'pttimenik-hemoluks',
    sourceUrl: 'https://www.pttimenik.com/demit-fasade-beograd/farbara-hemoluks-demit-fasada',
    sourceDomain: 'www.pttimenik.com',
    capturedAt: '2026-08-20',
    note: 'The business site plus fourteen unrelated advertiser sites.',
    links: [
      { href: 'mailto:hemoluks@beotel.rs', text: 'hemoluks@beotel.rs' },
      { href: 'https://www.hemoluks.com', text: 'https://www.hemoluks.com' },
      { href: 'https://maetidesigns.com/bex-preuzmi-predaj' },
      { href: 'http://injacframes.rs/sr/' },
      { href: 'http://roloas.co.rs/' },
      { href: 'https://www.stolarija-metalmont.com/' },
      { href: 'http://janikomerc.com/' },
      { href: 'https://www.mateks.rs/' },
      { href: 'https://www.zorboss.com/' },
      { href: 'https://autokucaholliday.co.rs/' },
      { href: 'https://majkinsalas.rs/' },
      { href: 'https://www.pomoravljedrvo.com/' },
      { href: 'https://www.pronails.rs/' },
      { href: 'https://fordsabac.rs/' },
      {
        href: 'http://facebook.com/sharer/sharer.php?u=https://www.pttimenik.com/demit-fasade-beograd/farbara-hemoluks-demit-fasada',
      },
      {
        href: 'https://twitter.com/intent/tweet?url=https://www.pttimenik.com/demit-fasade-beograd/farbara-hemoluks-demit-fasada',
      },
    ],
  },
  {
    id: 'stovarista-ucpartizan',
    sourceUrl: 'https://www.stovarista.rs/stovarista-beograd/uc-partizan-stovariste/',
    sourceDomain: 'www.stovarista.rs',
    capturedAt: '2026-08-20',
    note: 'The directory’s own gmail address sits next to the company’s site.',
    links: [
      { href: 'mailto:stovarista.srbije@gmail.com', text: 'stovarista.srbije@gmail.com' },
      { href: 'http://www.pttimenik.com' },
      { href: 'http://www.ucpartizan.com/', text: 'http://www.ucpartizan.com/' },
      { href: 'https://www.maximapaints.com/sr/pocetna' },
    ],
  },
  {
    id: 'superprostor-kalcer',
    sourceUrl: 'https://www.superprostor.com/profesionalci/kalcer',
    sourceDomain: 'www.superprostor.com',
    capturedAt: '2026-08-20',
    note: 'Only the portal’s own profiles and its Croatian edition.',
    links: [
      { href: 'https://www.facebook.com/superprostor' },
      {
        href: 'https://www.instagram.com/superprostor',
        text: '.e49e8cc9-77c8-4431-bf94-243daad7b336{fill:#231f20;}',
      },
      { href: 'https://www.linkedin.com/company/super-prostor' },
      { href: 'https://www.superprostor.hr', text: 'Hrvatska' },
    ],
  },
  {
    id: 'zutestrane-fermax',
    sourceUrl: 'https://zutestrane.net/firme/1819/fermax/',
    sourceDomain: 'zutestrane.net',
    capturedAt: '2026-08-20',
    note: 'The site is printed as text ("WEB sajt: http://www.fermax.co.rs"), not linked.',
    links: [{ href: 'http://www.fermax.co.rs', text: 'WEB sajt' }],
  },
];
