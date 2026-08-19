// FUZZ-8 / Q3 — Facade-relevant craft businesses in Serbia.
// The issue asked specifically for craft=plasterer|painter|builder.
// Result: this is the query that kills OSM as a contractor source.
[out:json][timeout:180];
area["ISO3166-1"="RS"][admin_level=2]->.rs;
(
  nwr["craft"="plasterer"](area.rs);
  nwr["craft"="painter"](area.rs);
  nwr["craft"="builder"](area.rs);
  nwr["craft"="tiler"](area.rs);
  nwr["craft"="roofer"](area.rs);
  nwr["craft"="insulation"](area.rs);
  nwr["craft"="stonemason"](area.rs);
  nwr["craft"="carpenter"](area.rs);
);
out tags center;
