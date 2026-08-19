// FUZZ-8 / Q6 — Administrative and settlement counts, used to size a
// city x query geographic sweep and to derive the Places API call budget.
// Run each `out count;` block separately; Overput returns one count per block.
[out:json][timeout:180];
area["ISO3166-1"="RS"][admin_level=2]->.rs;
relation["boundary"="administrative"]["admin_level"="8"](area.rs);
out count;
