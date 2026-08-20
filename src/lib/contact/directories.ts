/**
 * Hosts that are never a business's own website.
 *
 * The directory lists are curated by hand rather than derived from
 * `research/sources-*.json`, because some entries in those registries — the
 * manufacturer distributor pages, `austrotherm.rs` above all — are perfectly
 * good business websites when they turn up on someone else's listing. A
 * registry-derived list would silently drop them.
 */

/** Listing portals, classifieds and aggregators from the FUZZ-4 / FUZZ-5 source registries. */
export const KNOWN_DIRECTORY_DOMAINS: ReadonlySet<string> = new Set([
  '011info.com',
  '381info.com',
  'portal-srbija.com',
  'gradjevinarstvo.rs',
  'navidiku.rs',
  'gradjevinskefirme.cu.rs',
  'cu.rs',
  'poslovnikontakt.com',
  'goglasi.com',
  'oglasi.rs',
  'oglasi.cc',
  'zutestrane.net',
  'pttimenik.com',
  'biznisgroup.rs',
  'biznisgroup.com',
  'majstorimajstori.com',
  'poslovnikatalogsrbije.com',
  'superprostor.com',
  'daibau.rs',
  // The same operator under other brands, linked from every daibau footer.
  'mojmojster.net',
  'emajstor.hr',
  'kupujemprodajem.com',
  'nadjimajstora.rs',
  'samsvojmajstor.com',
  'privredniimenik.rs',
  'imenik.rs',
  'halooglasi.com',
  'nekretnine.rs',
  'nekretnine.cc',
  'lalafo.rs',
  'stovarista.rs',
  'mirandre.com',
  'yell.rs',
  'aladin.info',
  'e-majstori.rs',
  'besplatnioglasi.in.rs',
  'mapa.in.rs',
  'linkovi.in.rs',
  'openstreetmap.org',
  'overpass-turbo.eu',
  'apr.gov.rs',
]);

/**
 * Google properties. A Maps link is a social-profile signal, never a website;
 * anything else under google is infrastructure.
 */
export const GOOGLE_MAPS_HOST =
  /^(maps\.)?google\.[a-z]{2,3}(\.[a-z]{2,3})?$|^(maps\.app\.)?goo\.gl$|^g\.page$/i;

/** Social networks and messengers. The social extractor owns these. */
export const SOCIAL_DOMAINS: ReadonlySet<string> = new Set([
  'facebook.com',
  'fb.com',
  'fb.me',
  'messenger.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'pinterest.com',
  'plus.google.com',
  'telegram.me',
  't.me',
  'wa.me',
  'whatsapp.com',
  'viber.com',
  'vk.com',
  'snapchat.com',
  'threads.net',
]);

/** Platform, CDN, standards and analytics hosts nobody sells facades from. */
export const INFRASTRUCTURE_DOMAINS: ReadonlySet<string> = new Set([
  'w3.org',
  'schema.org',
  'gstatic.com',
  'googleapis.com',
  'googletagmanager.com',
  'google-analytics.com',
  'doubleclick.net',
  'cloudflare.com',
  'jquery.com',
  'bootstrapcdn.com',
  'fontawesome.com',
  'unpkg.com',
  'jsdelivr.net',
  'wordpress.org',
  'joomla.org',
  'drupal.org',
  'php.net',
  'mozilla.org',
  'adobe.com',
  'apple.com',
  'microsoft.com',
  'play.google.com',
  'apps.apple.com',
  'gravatar.com',
  'wix.com',
  'shopify.com',
  'cookiebot.com',
  'recaptcha.net',
]);

/**
 * Anchor text that marks the "site built by" credit in a footer. Serbian
 * directories all carry one, and it points at a web agency, not the business.
 */
export const VENDOR_CREDIT_TEXT =
  /\b(web\s*dizajn|webdizajn|izrada\s*(sajta|sajtova|web)|optimizacija\s*sajta|seo\b|hosting|powered\s*by|dizajn\s*i\s*izrada|održavanje\s*sajta|odrzavanje\s*sajta)/i;

/** URL shorteners — the real host only appears after one redirect hop. */
export const SHORTENER_DOMAINS: ReadonlySet<string> = new Set([
  'bit.ly',
  'goo.gl',
  'tinyurl.com',
  'ow.ly',
  't.co',
  'rb.gy',
  'cutt.ly',
  'is.gd',
  'shorturl.at',
  'maps.app.goo.gl',
  'g.page',
]);
