#!/usr/bin/env python3
"""Check complete UI translations, plural branches, and printf placeholders."""

from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys

LOCALES = ('en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'pt-BR', 'fr', 'de')
PLURAL_LOCALES = ('en', 'es', 'pt-BR', 'fr', 'de')
COUNT_KEYS = ('%lld 个 Prompt', '%lld 字符', '%lld 条内容', '包含 %lld 个文件')
# Shared technical terms, cognates, and standard acknowledgements are intentional.
SHARED_ENGLISH = {
    '%lld 个 Prompt': {'es', 'pt-BR', 'fr', 'de'},
    '图片': {'fr'},
    '塔罗': {'es', 'fr', 'de'},
    '原文': {'es', 'pt-BR', 'fr', 'de'},
    '文本': {'de'},
    '版本': {'fr', 'de'},
    '电影': {'pt-BR'},
    '知道了': {'ja', 'pt-BR', 'fr', 'de'},
    '网站': {'de'},
    '网页': {'es', 'pt-BR', 'fr', 'de'},
    '视频': {'de'},
}
PRINTF = re.compile(
    r"%(?:\d+\$)?[-+#0 ']*(?:\d+|\*)?(?:\.(?:\d+|\*))?"
    r"(?:hh|ll|h|l|j|z|t|L)?[@diuoxXfFeEgGaAcCsSpn%]"
)


def placeholders(value: str) -> Counter[str]:
    # Positional indexes may change to accommodate word order, but types,
    # lengths, multiplicity, and formatting options must stay intact.
    return Counter(
        re.sub(r'^%\d+\$', '%', match.group())
        for match in PRINTF.finditer(value)
        if match.group() != '%%'
    )


def units(node: dict, path: str = ''):
    if 'stringUnit' in node:
        yield path, node['stringUnit']
    for dimension, choices in node.get('variations', {}).items():
        for choice, child in choices.items():
            yield from units(child, f'{path}/{dimension}/{choice}')
    for name, child in node.get('substitutions', {}).items():
        yield from units(child, f'{path}/substitutions/{name}')


def check(path: Path) -> int:
    catalog = json.loads(path.read_text())
    errors: list[str] = []
    counts = Counter()
    excluded = 0
    for key, entry in catalog['strings'].items():
        if not entry.get('shouldTranslate', True):
            excluded += 1
            continue
        expected = placeholders(key)
        english = {unit.get('value') for _, unit in units(entry.get('localizations', {}).get('en', {}))}
        for locale in LOCALES:
            localization = entry.get('localizations', {}).get(locale)
            if localization is None:
                errors.append(f'{key!r}: missing {locale}')
                continue
            leaves = list(units(localization))
            if not leaves:
                errors.append(f'{key!r}: no string units for {locale}')
                continue
            counts[locale] += 1
            for branch, unit in leaves:
                value = unit.get('value', '')
                label = f'{key!r} [{locale}{branch}]'
                if not value.strip():
                    errors.append(f'{label}: blank value')
                if unit.get('state') != 'translated':
                    errors.append(f'{label}: state is not translated')
                if placeholders(value) != expected:
                    errors.append(f'{label}: printf placeholders differ from source')
                if locale not in ('en', 'zh-Hans') and value in english and locale not in SHARED_ENGLISH.get(key, set()):
                    errors.append(f'{label}: unexpected English fallback')
                # This catches missing CJK translations while allowing the
                # short Chinese/Japanese acknowledgement "OK".
                if locale == 'zh-Hant' and not re.search(r'[\u3400-\u9fff]', value):
                    errors.append(f'{label}: no Chinese text')
                if locale == 'ja' and value != 'OK' and not re.search(r'[\u3040-\u30ff\u3400-\u9fff]', value):
                    errors.append(f'{label}: no Japanese text')
                if locale == 'ko' and not re.search(r'[\uac00-\ud7a3]', value):
                    errors.append(f'{label}: no Korean text')
            if key in COUNT_KEYS and locale in PLURAL_LOCALES:
                plural = localization.get('variations', {}).get('plural', {})
                if not {'one', 'other'} <= plural.keys():
                    errors.append(f'{key!r} [{locale}]: missing one/other plural forms')
    total = len(catalog['strings']) - excluded
    print(f'{total} translatable keys; {excluded} nontranslatable keys excluded')
    print(', '.join(f'{locale}: {counts[locale]}/{total}' for locale in LOCALES))
    if errors:
        for error in errors:
            print(f'ERROR: {error}', file=sys.stderr)
        return 1
    print('PASS: coverage, translated states, placeholders, plurals, and fallback audit')
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('catalog', nargs='?', type=Path, default=Path(__file__).resolve().parents[1] / 'ios/Prompix/Resources/Localizable.xcstrings')
    args = parser.parse_args()
    return check(args.catalog)


if __name__ == '__main__':
    raise SystemExit(main())
