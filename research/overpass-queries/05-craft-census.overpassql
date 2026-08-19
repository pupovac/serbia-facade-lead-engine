// FUZZ-8 / Q5 — Census of every craft=* value in Serbia, to prove the
// contractor gap is a coverage problem in OSM and not a wrong-tag problem.
[out:json][timeout:180];
area["ISO3166-1"="RS"][admin_level=2]->.rs;
nwr["craft"](area.rs);
out tags center;
