#!/usr/bin/env python3
"""Builds assets/data.json and assets/img/ from the research source folder.

The research folder stays the place where content is edited; this script is the
only bridge from it to the site. It ports the merge and validation logic of
sayfa/build_rehber.py, but writes a plain JSON file instead of an HTML page.

Usage: python3 tools/build_data.py
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.expanduser('~/research_notes/Los Angeles aile tatili seçenekleri')
SAYFA = os.path.join(SRC, 'sayfa')
KAT = os.path.join(SRC, 'katalog')
OUT_JSON = os.path.join(ROOT, 'assets', 'data.json')
OUT_IMG = os.path.join(ROOT, 'assets', 'img')

DETAIL_FIELDS = ('name', 'tickets', 'crowd', 'parking', 'food', 'days', 'book', 'limits', 'warn')


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def insert_after(sections, anchor_id, section):
    names = [s['id'] for s in sections]
    at = names.index(anchor_id) + 1 if anchor_id in names else len(names)
    sections.insert(at, section)


def main():
    sorular = load(os.path.join(SAYFA, 'sorular.json'))
    catalog = load(os.path.join(KAT, 'catalog.json'))
    credits_all = load(os.path.join(SAYFA, 'credits.json'))
    by_id = {o['id']: o for o in catalog['options']}
    sections = sorular['sections']

    local_path = os.path.join(KAT, 'yerel_aktivite.json')
    if os.path.exists(local_path):
        insert_after(sections, 'hollywood', {
            'id': 'yerel',
            'title': 'Yerel LA',
            'lead': "LA'lilerin çocuklarıyla yaptığı şeyler ve otelin çevresi: kolay yarım günler ve akşamlar için.",
            'questions': load(local_path)['questions'],
        })

    food_path = os.path.join(KAT, 'yerel_yemek.json')
    if os.path.exists(food_path):
        food_questions = load(food_path)['questions']
        for q in food_questions:
            q['food'] = True
        insert_after(sections, 'yemek', {
            'id': 'lezzet',
            'title': 'Yerel lezzetler',
            'lead': "LA'in asıl yemek kültürü taco kamyonlarında, mahalle lokantalarında ve pazarlarda. Süreler otelden ve trafiksiz; akşam trafiğinde iki katına çıkabilir. Saatler Eylül 2026 bilgisi, Mart öncesi yeniden bakacağım.",
            'questions': food_questions,
        })

    details, used_imgs, problems, qids = {}, set(), [], set()
    n_questions = n_options = 0
    for section in sections:
        for q in section['questions']:
            n_questions += 1
            if q['id'] in qids:
                problems.append('dup question ' + q['id'])
            qids.add(q['id'])
            for k in (q.get('compare') or {}).get('imgs', []):
                if k:
                    used_imgs.add(k)
            option_ids = set()
            for o in q.get('options', []):
                n_options += 1
                if o['id'] in option_ids:
                    problems.append(f"dup option {q['id']}/{o['id']}")
                option_ids.add(o['id'])
                for k in ('img', 'img2'):
                    if o.get(k):
                        used_imgs.add(o[k])
                for cid in o.get('ids', []):
                    c = by_id.get(cid)
                    if not c:
                        problems.append(f"unknown catalog id {cid} in {q['id']}/{o['id']}")
                        continue
                    details[cid] = {k: c.get(k, '') for k in DETAIL_FIELDS}

    for k in sorted(used_imgs):
        if not os.path.exists(os.path.join(SAYFA, 'img', k + '.jpg')):
            problems.append(f'missing image file {k}.jpg')
        if k not in credits_all:
            problems.append(f'missing credit {k}')

    credits = {k: {kk: credits_all[k][kk] for kk in ('artist', 'license', 'page')}
               for k in sorted(used_imgs) if k in credits_all}
    data = {'sections': sections, 'details': details, 'credits': credits}

    print(f'sections {len(sections)}, questions {n_questions}, options {n_options}, '
          f'details {len(details)}, credits {len(credits)}, images {len(used_imgs)}')
    if problems:
        print('problems:')
        for p in problems:
            print('  -', p)
        return 1

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    shutil.rmtree(OUT_IMG, ignore_errors=True)
    os.makedirs(OUT_IMG)
    for k in sorted(used_imgs):
        shutil.copyfile(os.path.join(SAYFA, 'img', k + '.jpg'), os.path.join(OUT_IMG, k + '.jpg'))
    print(f'wrote {os.path.relpath(OUT_JSON, ROOT)} ({os.path.getsize(OUT_JSON)} bytes) and {len(used_imgs)} images')
    return 0


if __name__ == '__main__':
    sys.exit(main())
