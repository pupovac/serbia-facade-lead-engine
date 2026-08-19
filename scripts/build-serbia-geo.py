#!/usr/bin/env python3
"""Regenerate data/serbia-geo.json from public sources.

Run with `python3 scripts/build-serbia-geo.py`. It fetches four Wikipedia pages
through the MediaWiki API, parses the RZS 2022 census table, the RATEL area-code
table and the Pošta Srbije postal-code list, and writes data/serbia-geo.json.

The Serbian case forms in OVERRIDES / inflect() are the part that matters most:
Serbian is inflected, so listings say "fasader u Novom Sadu", not "fasader Novi
Sad". Every entry's variants were reviewed by hand against the generated output.
"""
from __future__ import annotations

import collections
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

UA = 'serbia-facade-lead-engine/1.0 (dataset build; +https://github.com/pupovac/serbia-facade-lead-engine)'
OUT = Path(__file__).resolve().parent.parent / 'data' / 'serbia-geo.json'

# --- transliteration --------------------------------------------------------
CYR2LAT = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ђ': 'đ', 'е': 'e', 'ж': 'ž',
    'з': 'z', 'и': 'i', 'ј': 'j', 'к': 'k', 'л': 'l', 'љ': 'lj', 'м': 'm', 'н': 'n',
    'њ': 'nj', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'ћ': 'ć', 'у': 'u',
    'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'č', 'џ': 'dž', 'ш': 'š',
    'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Ђ': 'Đ', 'Е': 'E', 'Ж': 'Ž',
    'З': 'Z', 'И': 'I', 'Ј': 'J', 'К': 'K', 'Л': 'L', 'Љ': 'Lj', 'М': 'M', 'Н': 'N',
    'Њ': 'Nj', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'Ћ': 'Ć', 'У': 'U',
    'Ф': 'F', 'Х': 'H', 'Ц': 'C', 'Ч': 'Č', 'Џ': 'Dž', 'Ш': 'Š',
}
LAT2CYR_DIGRAPHS = [('Lj', 'Љ'), ('LJ', 'Љ'), ('lj', 'љ'), ('Nj', 'Њ'), ('NJ', 'Њ'),
                    ('nj', 'њ'), ('Dž', 'Џ'), ('DŽ', 'Џ'), ('dž', 'џ')]
LAT2CYR = {v: k for k, v in CYR2LAT.items() if len(v) == 1}
FOLD = {'đ': 'dj', 'Đ': 'Dj', 'ž': 'z', 'Ž': 'Z', 'ć': 'c', 'Ć': 'C',
        'č': 'c', 'Č': 'C', 'š': 's', 'Š': 'S'}


def to_lat(s: str) -> str:
    return ''.join(CYR2LAT.get(ch, ch) for ch in s)


def to_cyr(s: str) -> str:
    for a, b in LAT2CYR_DIGRAPHS:
        s = s.replace(a, b)
    return ''.join(LAT2CYR.get(ch, ch) for ch in s)


def fold(s: str) -> str:
    """ASCII-fold Serbian Latin. Must agree with foldDiacritics() in src/lib/text/fold.ts."""
    s = s.replace('dž', 'dz').replace('Dž', 'Dz').replace('DŽ', 'DZ')
    return ''.join(FOLD.get(ch, ch) for ch in s)


def slug(name: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', fold(name).lower()).strip('-')


# --- fetching ---------------------------------------------------------------
def wikitext(host: str, page: str) -> str:
    params = urllib.parse.urlencode({
        'action': 'parse', 'page': page, 'prop': 'wikitext',
        'format': 'json', 'formatversion': '2',
    })
    req = urllib.request.Request(f'https://{host}/w/api.php?{params}', headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)['parse']['wikitext']


def linked(text: str) -> str | None:
    m = re.search(r'\[\[([^\]]+)\]\]', text)
    return m.group(1).split('|')[-1].strip() if m else None


# --- source 1: RZS 2022 census table (sr.wikipedia transcription) -----------
def parse_units() -> list[dict]:
    """The 144 local self-government units outside Belgrade, with 2022 census figures.

    Cities that are split into city municipalities use rowspan and carry an
    "Укупно" (total) sub-row; that total is the city-level figure we want.
    """
    w = wikitext('sr.wikipedia.org', 'Градови и општине Србије')
    parts = re.split(r'^== (.+?) ==\s*$', w, flags=re.M)
    sections = {parts[i].strip(): parts[i + 1] for i in range(1, len(parts), 2)}

    def num(cell: str) -> int | None:
        cell = re.sub(r'^align="\w+"\s*\|', '', cell).strip().replace("'''", '').replace('.', '')
        return int(cell) if cell.isdigit() else None

    units: list[dict] = []
    for section in ('Војводина', 'Централна Србија'):  # Kosovo and Metohija is out of scope
        table = sections[section]
        start, end = table.find('{|'), table.find('\n|}', table.find('{|'))
        pending: dict | None = None
        for block in re.split(r'\n\|-+\s*\n', table[start:end]):
            cells = [c.strip() for c in re.split(r'\n\|(?!\|)', block) if c.strip()]
            if not cells:
                continue
            text = '\n'.join(cells)
            numbers = [n for n in (num(c) for c in cells) if n is not None]
            district_m = re.search(r'\[\[([^\]|]*управни округ)\|([^\]]+)\]\]', text)
            district = district_m.group(2) if district_m else None
            city_m = re.search(r'\[\[Град ([^\]|]+)(?:\|([^\]]+))?\]\]', text)
            muni_m = re.search(r'\[\[Општина ([^\]|]+)(?:\|([^\]]+))?\]\]', text)

            if city_m:
                pending = {'name': (city_m.group(2) or city_m.group(1)).strip(),
                           'type': 'city', 'district': district}
                is_split = bool(re.search(r'\[\[Градска општина', text))
                if not is_split and len(numbers) >= 3:
                    pending.update(area=numbers[0], pop=numbers[1], settlements=numbers[2])
                    units.append(pending)
                    pending = None
                continue
            if 'Укупно' in text and pending:
                pending.update(area=numbers[0], pop=numbers[1], settlements=numbers[2])
                units.append(pending)
                pending = None
                continue
            if re.search(r'\[\[Градска општина', text):
                continue  # a city municipality of Niš / Požarevac / Užice / Vranje
            if muni_m and len(numbers) >= 3:
                units.append({'name': (muni_m.group(2) or muni_m.group(1)).strip(),
                              'type': 'municipality', 'district': district,
                              'area': numbers[0], 'pop': numbers[1], 'settlements': numbers[2]})
    for u in units:
        u['name'] = to_lat(u['name'])
        u['district'] = to_lat(u['district'])
    return units


# --- source 2: en.wikipedia list, used purely as a cross-check --------------
def parse_crosscheck() -> set[str]:
    w = wikitext('en.wikipedia.org', 'Municipalities and cities of Serbia')
    names: set[str] = set()
    end = w.find('==Municipalities of Kosovo==')  # Kosovo units are out of scope
    for row in w[:end].split('\n|-'):
        cells = row.split('||')
        if len(cells) < 4:
            continue
        name = linked(cells[2])
        if name and '[[File:' not in cells[2].split('||')[0]:
            names.add(name)
    return names


# --- source 3: postal codes of the municipal seat ---------------------------
def parse_postal() -> dict[str, list[str]]:
    w = wikitext('sr.wikipedia.org', 'Списак поштанских бројева у Србији')
    seats: dict[str, set[str]] = collections.defaultdict(set)
    for row in w.split('\n|-'):
        cells = row.split('||')
        if len(cells) < 4:
            continue
        place = linked(cells[0].lstrip('|\n ')) or cells[0].strip()
        code = re.search(r'\d{5}', cells[1])
        muni = linked(cells[3]) or cells[3].strip()
        if not code:
            continue
        place = to_lat(place)
        muni = re.sub(r'^(Опш+тина|Град)\s+', '', to_lat(muni))
        muni = re.sub(r'^(Opština|Grad)\s+', '', muni)
        if place == muni:
            seats[muni].add(code.group(0))
    return {k: sorted(v) for k, v in seats.items()}


# --- source 4: RATEL area codes (en.wikipedia transcription) ----------------
# The first municipality of each list is the network-group centre the code is
# named after. Transcribed from "Telephone numbers in Serbia"; kept inline so a
# rebuild does not silently change phone-to-city inference if the page is edited.
AREA_CODES: dict[str, list[str]] = {
    '11': ['Beograd', 'Barajevo', 'Grocka', 'Lazarevac', 'Mladenovac', 'Obrenovac', 'Sopot',
           'Surčin', 'Čukarica', 'Novi Beograd', 'Palilula', 'Rakovica', 'Savski Venac',
           'Stari Grad', 'Voždovac', 'Vračar', 'Zemun', 'Zvezdara'],
    '30': ['Bor', 'Boljevac', 'Majdanpek'],
    '32': ['Čačak', 'Gornji Milanovac', 'Ivanjica', 'Lučani'],
    '35': ['Jagodina', 'Ćuprija', 'Despotovac', 'Paraćin', 'Rekovac', 'Svilajnac'],
    '230': ['Kikinda', 'Čoka', 'Novi Kneževac'],
    '34': ['Kragujevac', 'Aranđelovac', 'Batočina', 'Knić', 'Lapovo', 'Rača', 'Topola'],
    '36': ['Kraljevo', 'Raška', 'Vrnjačka Banja'],
    '37': ['Kruševac', 'Aleksandrovac', 'Brus', 'Ćićevac', 'Ražanj', 'Trstenik', 'Varvarin'],
    '16': ['Leskovac', 'Bojnik', 'Crna Trava', 'Lebane', 'Medveđa', 'Vlasotince'],
    '18': ['Niš', 'Aleksinac', 'Bela Palanka', 'Doljevac', 'Gadžin Han', 'Merošina',
           'Sokobanja', 'Svrljig'],
    '20': ['Novi Pazar', 'Sjenica', 'Tutin'],
    '21': ['Novi Sad', 'Bač', 'Bačka Palanka', 'Bački Petrovac', 'Bečej', 'Beočin', 'Temerin',
           'Titel', 'Srbobran', 'Sremski Karlovci', 'Vrbas', 'Žabalj'],
    '13': ['Pančevo', 'Alibunar', 'Bela Crkva', 'Kovačica', 'Kovin', 'Opovo', 'Plandište', 'Vršac'],
    '10': ['Pirot', 'Babušnica', 'Dimitrovgrad'],
    '12': ['Požarevac', 'Golubac', 'Kučevo', 'Petrovac na Mlavi', 'Veliko Gradište', 'Žabari',
           'Žagubica', 'Malo Crniće'],
    '33': ['Prijepolje', 'Nova Varoš', 'Priboj'],
    '27': ['Prokuplje', 'Blace', 'Kuršumlija', 'Žitorađa'],
    '26': ['Smederevo', 'Smederevska Palanka', 'Velika Plana'],
    '25': ['Sombor', 'Apatin', 'Kula', 'Odžaci'],
    '22': ['Sremska Mitrovica', 'Inđija', 'Irig', 'Pećinci', 'Ruma', 'Stara Pazova', 'Šid'],
    '24': ['Subotica', 'Ada', 'Bačka Topola', 'Kanjiža', 'Mali Iđoš', 'Senta'],
    '15': ['Šabac', 'Bogatić', 'Koceljeva', 'Krupanj', 'Ljubovija', 'Loznica', 'Mali Zvornik',
           'Vladimirci'],
    '31': ['Užice', 'Arilje', 'Bajina Bašta', 'Čajetina', 'Kosjerić', 'Požega'],
    '14': ['Valjevo', 'Lajkovac', 'Ljig', 'Mionica', 'Osečina', 'Ub'],
    '17': ['Vranje', 'Bosilegrad', 'Bujanovac', 'Preševo', 'Surdulica', 'Trgovište', 'Vladičin Han'],
    '19': ['Zaječar', 'Kladovo', 'Knjaževac', 'Negotin'],
    '23': ['Zrenjanin', 'Novi Bečej', 'Sečanj', 'Nova Crnja', 'Žitište'],
}

# --- Serbian case forms -----------------------------------------------------
# (genitive, locative). Everything multi-word, plurale tantum, or carrying a
# consonant alternation is listed explicitly; the rest falls through to inflect().
OVERRIDES: dict[str, tuple[str, str]] = {
    'Bajina Bašta': ('Bajine Bašte', 'Bajinoj Bašti'),
    'Bačka Palanka': ('Bačke Palanke', 'Bačkoj Palanci'),
    'Bačka Topola': ('Bačke Topole', 'Bačkoj Topoli'),
    'Bački Petrovac': ('Bačkog Petrovca', 'Bačkom Petrovcu'),
    'Bela Crkva': ('Bele Crkve', 'Beloj Crkvi'),
    'Bela Palanka': ('Bele Palanke', 'Beloj Palanci'),
    'Crna Trava': ('Crne Trave', 'Crnoj Travi'),
    'Gadžin Han': ('Gadžinog Hana', 'Gadžinom Hanu'),
    'Gornji Milanovac': ('Gornjeg Milanovca', 'Gornjem Milanovcu'),
    'Mali Iđoš': ('Malog Iđoša', 'Malom Iđošu'),
    'Mali Zvornik': ('Malog Zvornika', 'Malom Zvorniku'),
    'Malo Crniće': ('Malog Crnića', 'Malom Crniću'),
    'Nova Crnja': ('Nove Crnje', 'Novoj Crnji'),
    'Nova Varoš': ('Nove Varoši', 'Novoj Varoši'),
    'Novi Bečej': ('Novog Bečeja', 'Novom Bečeju'),
    'Novi Kneževac': ('Novog Kneževca', 'Novom Kneževcu'),
    'Novi Pazar': ('Novog Pazara', 'Novom Pazaru'),
    'Novi Sad': ('Novog Sada', 'Novom Sadu'),
    'Petrovac na Mlavi': ('Petrovca na Mlavi', 'Petrovcu na Mlavi'),
    'Smederevska Palanka': ('Smederevske Palanke', 'Smederevskoj Palanci'),
    'Sremska Mitrovica': ('Sremske Mitrovice', 'Sremskoj Mitrovici'),
    'Sremski Karlovci': ('Sremskih Karlovaca', 'Sremskim Karlovcima'),
    'Stara Pazova': ('Stare Pazove', 'Staroj Pazovi'),
    'Velika Plana': ('Velike Plane', 'Velikoj Plani'),
    'Veliko Gradište': ('Velikog Gradišta', 'Velikom Gradištu'),
    'Vladičin Han': ('Vladičinog Hana', 'Vladičinom Hanu'),
    'Vrnjačka Banja': ('Vrnjačke Banje', 'Vrnjačkoj Banji'),
    'Novi Beograd': ('Novog Beograda', 'Novom Beogradu'),
    'Savski Venac': ('Savskog Venca', 'Savskom Vencu'),
    'Stari Grad': ('Starog Grada', 'Starom Gradu'),
    # plurale tantum
    'Lučani': ('Lučana', 'Lučanima'),
    'Odžaci': ('Odžaka', 'Odžacima'),
    'Pećinci': ('Pećinaca', 'Pećincima'),
    'Vladimirci': ('Vladimiraca', 'Vladimircima'),
    'Žabari': ('Žabara', 'Žabarima'),
    # consonant alternation / fleeting -a- outside the regular -ac pattern
    'Golubac': ('Golupca', 'Golupcu'),
    'Šabac': ('Šapca', 'Šapcu'),
    'Čačak': ('Čačka', 'Čačku'),
    'Krupanj': ('Krupnja', 'Krupnju'),
    'Ražanj': ('Ražnja', 'Ražnju'),
    'Sečanj': ('Sečnja', 'Sečnju'),
    'Žabalj': ('Žablja', 'Žablju'),
    # adjectival feminine
    'Grocka': ('Grocke', 'Grockoj'),
}


def inflect(name: str) -> tuple[str, str]:
    if name in OVERRIDES:
        return OVERRIDES[name]
    if name.endswith('ac'):            # fleeting -a-: Kragujevac -> Kragujevca / Kragujevcu
        stem = name[:-2] + 'c'
        return stem + 'a', stem + 'u'
    if name.endswith('a'):             # feminine: Subotica -> Subotice / Subotici
        return name[:-1] + 'e', name[:-1] + 'i'
    if name.endswith(('o', 'e')):      # neuter: Valjevo -> Valjeva / Valjevu
        return name[:-1] + 'a', name[:-1] + 'u'
    return name + 'a', name + 'u'      # masculine consonant stem: Bor -> Bora / Boru


def variants(name: str) -> list[str]:
    genitive, locative = inflect(name)
    out: list[str] = []
    for form in (name, locative, genitive):
        for spelling in (form, fold(form)):
            if spelling not in out:
                out.append(spelling)
    return out


# --- districts and NSTJ-2 statistical regions -------------------------------
REGION_OF_DISTRICT = {d: 'Vojvodina' for d in (
    'Severnobački', 'Srednjobanatski', 'Severnobanatski', 'Južnobanatski',
    'Zapadnobački', 'Južnobački', 'Sremski')}
REGION_OF_DISTRICT.update({d: 'Šumadija i Zapadna Srbija' for d in (
    'Mačvanski', 'Kolubarski', 'Šumadijski', 'Pomoravski', 'Zlatiborski',
    'Moravički', 'Raški', 'Rasinski')})
REGION_OF_DISTRICT.update({d: 'Južna i Istočna Srbija' for d in (
    'Podunavski', 'Braničevski', 'Borski', 'Zaječarski', 'Nišavski', 'Toplički',
    'Pirotski', 'Jablanički', 'Pčinjski')})
REGION_OF_DISTRICT['Grad Beograd'] = 'Beogradski region'

# --- City of Belgrade -------------------------------------------------------
# Belgrade is one local self-government unit that is not in the table above; its
# 17 city municipalities are carried as separate records with parent_id "beograd".
BELGRADE = {'name': 'Beograd', 'type': 'city', 'district': 'Grad Beograd',
            'pop': 1681405, 'area': 3235, 'settlements': None}
BG_CORE = ['Čukarica', 'Novi Beograd', 'Palilula', 'Rakovica', 'Savski Venac', 'Stari Grad',
           'Voždovac', 'Vračar', 'Zemun', 'Zvezdara']
BG_OUTER = ['Barajevo', 'Grocka', 'Lazarevac', 'Mladenovac', 'Obrenovac', 'Sopot', 'Surčin']
BG_POP = {'Čukarica': 175793, 'Novi Beograd': 209763, 'Palilula': 182624, 'Rakovica': 104456,
          'Savski Venac': 36699, 'Stari Grad': 44737, 'Voždovac': 174864, 'Vračar': 55406,
          'Zemun': 177908, 'Zvezdara': 172625, 'Barajevo': 26431, 'Grocka': 82810,
          'Lazarevac': 55146, 'Mladenovac': 56389, 'Obrenovac': 68882, 'Sopot': 19126,
          'Surčin': 45452}
BG_CENSUS_YEAR = {'Zemun': 2011, 'Mladenovac': 2011, 'Obrenovac': 2011, 'Surčin': 2011}

# Seats the postal list files under a different post-office name, or where it
# carries the main-post-office code (…101 / …501) instead of the round code in
# general use. Verified against the same list.
POSTAL_MANUAL = {
    'Beograd': ['11000'], 'Novi Sad': ['21000'], 'Niš': ['18000'], 'Kragujevac': ['34000'],
    'Čačak': ['32000'], 'Sombor': ['25000'], 'Zrenjanin': ['23000'], 'Vranje': ['17500'],
    'Petrovac na Mlavi': ['12300'],  # post office "Petrovac"
    'Rača': ['34210'],               # post office "Rača Kragujevačka"
    'Barajevo': ['11460'], 'Grocka': ['11306'], 'Lazarevac': ['11550'], 'Mladenovac': ['11400'],
    'Obrenovac': ['11500'], 'Sopot': ['11450'], 'Surčin': ['11271'], 'Čukarica': ['11030'],
    'Novi Beograd': ['11070'], 'Palilula': ['11000'], 'Rakovica': ['11090'],
    'Savski Venac': ['11000'], 'Stari Grad': ['11000'], 'Voždovac': ['11040'],
    'Vračar': ['11000'], 'Zemun': ['11080'], 'Zvezdara': ['11000'],
}


def main() -> None:
    units = parse_units()
    crosscheck = parse_crosscheck()
    names = {u['name'] for u in units} | {'Belgrade'}
    missing, extra = crosscheck - names, names - crosscheck - {'Belgrade'}
    if missing or extra:
        raise SystemExit(f'unit list disagrees with en.wikipedia cross-check: {missing=} {extra=}')
    print(f'cross-check OK: {len(units)} units + Belgrade = {len(units) + 1}')

    seat_postal = parse_postal()
    prefix: dict[str, str] = {}
    group_center: set[str] = set()
    for code, members in AREA_CODES.items():
        group_center.add(members[0])
        for m in members:
            prefix[m] = '0' + code

    units.append(BELGRADE)
    tier1 = {u['name'] for u in sorted(units, key=lambda u: -u['pop'])[:20]}

    def record(name, kind, district, pop, year, area, settlements, tier, parent):
        genitive, locative = inflect(name)
        return {
            'id': (f'beograd-{slug(name)}' if parent else slug(name)),
            'name_sr': name,
            'name_ascii': fold(name),
            'name_cyrillic': to_cyr(name),
            'search_variants': variants(name),
            'search_variants_cyrillic': [to_cyr(f) for f in (name, locative, genitive)],
            'type': kind,
            'district': district if district == 'Grad Beograd' else f'{district} okrug',
            'region': REGION_OF_DISTRICT[district],
            'population': pop,
            'population_census_year': year,
            'area_km2': area,
            'settlement_count': settlements,
            'postal_codes': POSTAL_MANUAL.get(name) or seat_postal.get(name) or [],
            'landline_prefix': prefix.get(name),
            'landline_group_center': name in group_center and not parent,
            'priority_tier': tier,
            'parent_id': parent,
        }

    records = [
        record(u['name'], u['type'], u['district'], u['pop'], 2022, u['area'], u['settlements'],
               1 if u['name'] in tier1 else (2 if u['pop'] >= 20000 else 3), None)
        for u in sorted(units, key=lambda u: slug(u['name']))
    ]
    records += [
        record(n, 'city_municipality', 'Grad Beograd', BG_POP[n], BG_CENSUS_YEAR.get(n, 2022),
               None, None, 1 if n in BG_CORE else 2, 'beograd')
        for n in sorted(BG_CORE + BG_OUTER, key=slug)
    ]

    gaps = [r['id'] for r in records
            if not r['landline_prefix'] or not r['postal_codes'] or len(r['search_variants']) < 2]
    if gaps:
        raise SystemExit(f'incomplete records: {gaps}')

    doc = {
        '_meta': {
            'description': 'Canonical geographic coverage dataset for Serbia (excluding Kosovo and Metohija). Every geographic crawl in this project iterates over this file.',
            'unit_count': len([r for r in records if r['type'] != 'city_municipality']),
            'city_municipality_count': len([r for r in records if r['type'] == 'city_municipality']),
            'generated_by': 'scripts/build-serbia-geo.py',
            'sources': [
                {'name': 'Statistical Office of the Republic of Serbia — 2022 Census of Population, Households and Dwellings, data by municipalities and cities (G20234001)',
                 'url': 'https://publikacije.stat.gov.rs/G2023/Pdf/G20234001.pdf',
                 'used_for': 'population (2022 census), area, settlement count, administrative district'},
                {'name': 'Wikipedia (sr) — Градови и општине Србије',
                 'url': 'https://sr.wikipedia.org/wiki/Градови_и_општине_Србије',
                 'used_for': 'machine-readable transcription of the RZS 2022 census table'},
                {'name': 'Wikipedia (en) — Municipalities and cities of Serbia',
                 'url': 'https://en.wikipedia.org/wiki/Municipalities_and_cities_of_Serbia',
                 'used_for': 'independent cross-check of the unit list against the Law on Territorial Organisation of the Republic of Serbia (Sl. glasnik RS 129/2007, 18/2016, 47/2018): 117 municipalities + 28 cities de facto'},
                {'name': 'RATEL numbering plan, via Wikipedia (en) — Telephone numbers in Serbia',
                 'url': 'https://en.wikipedia.org/wiki/Telephone_numbers_in_Serbia',
                 'used_for': 'landline_prefix and landline_group_center'},
                {'name': 'Pošta Srbije postal code list, via Wikipedia (sr) — Списак поштанских бројева у Србији',
                 'url': 'https://sr.wikipedia.org/wiki/Списак_поштанских_бројева_у_Србији',
                 'used_for': 'postal_codes of the municipal seat'},
            ],
            'authority_note': 'The unit list is cross-checked name by name at build time against the English Wikipedia list of municipalities and cities of Serbia, which is sourced from the Law on Territorial Organisation of the Republic of Serbia. The build fails if the two disagree. Both lists agree on all 145 local self-government units.',
            'kosovo_note': 'The 28 municipalities of Kosovo and Metohija are deliberately excluded: they are not administered by Serbian institutions and are out of scope for this project.',
            'priority_tier_rule': 'Computed over the 145 local self-government units by 2022 census population: tier 1 = the 20 most populous, tier 2 = population >= 20,000, tier 3 = the rest. Belgrade city municipalities are tiered separately — the 10 urban-core ones are tier 1, the 7 suburban ones are tier 2.',
            'population_note': 'population is the 2022 census figure for the whole local self-government unit, not just its seat settlement. The Belgrade city municipalities marked population_census_year 2011 had no 2022 figure in the sources above.',
            'postal_codes_note': 'postal_codes lists the code(s) of the municipal seat post office, not every code inside the unit.',
            'landline_prefix_note': 'Serbian landline area codes are shared across a whole RATEL network group, so one prefix maps to many municipalities. landline_group_center marks the municipality a code is named after — use it when a landline number is the only location signal.',
            'search_variants_note': 'Nominative, locative and genitive of the place name, each in both the diacritic and the ASCII-folded spelling. Serbian is inflected — listings say "fasader u Novom Sadu", not "fasader Novi Sad" — so a geographic query must be built from these variants, not from name_sr alone.',
        },
        'municipalities': records,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'wrote {OUT} ({len(records)} records)')


if __name__ == '__main__':
    main()
