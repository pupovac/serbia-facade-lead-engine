// FUZZ-8 / Q4 — Construction companies tagged as offices.
// The only OSM tag with usable contractor-side phone density in Serbia.
[out:json][timeout:180];
area["ISO3166-1"="RS"][admin_level=2]->.rs;
nwr["office"="construction_company"](area.rs);
out tags center;
