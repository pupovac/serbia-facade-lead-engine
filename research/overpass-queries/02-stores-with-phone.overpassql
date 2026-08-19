// FUZZ-8 / Q2 — Same store set, restricted to records that actually carry a phone.
// This is the number that matters for a phone-first product.
[out:json][timeout:180];
area["ISO3166-1"="RS"][admin_level=2]->.rs;
(
  nwr["shop"~"^(doityourself|hardware|trade|paint|building_materials|tiles|bathroom_furnishing|flooring)$"]["phone"](area.rs);
  nwr["shop"~"^(doityourself|hardware|trade|paint|building_materials|tiles|bathroom_furnishing|flooring)$"]["contact:phone"](area.rs);
  nwr["shop"~"^(doityourself|hardware|trade|paint|building_materials|tiles|bathroom_furnishing|flooring)$"]["mobile"](area.rs);
);
out tags center;
