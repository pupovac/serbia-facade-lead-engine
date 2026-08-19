// FUZZ-8 / Q1 — Construction-material and hardware stores in Serbia.
// Every OSM tag value that can plausibly hold a `CONSTRUCTION_MATERIAL_STORE`.
// Endpoint: https://overpass-api.de/api/interpreter  (POST form field `data`)
[out:json][timeout:180];
area["ISO3166-1"="RS"][admin_level=2]->.rs;
(
  nwr["shop"="doityourself"](area.rs);
  nwr["shop"="hardware"](area.rs);
  nwr["shop"="trade"](area.rs);
  nwr["shop"="paint"](area.rs);
  nwr["shop"="building_materials"](area.rs);
  nwr["shop"="tiles"](area.rs);
  nwr["shop"="bathroom_furnishing"](area.rs);
  nwr["shop"="flooring"](area.rs);
);
out tags center;
