# UI localization QA

The iOS string catalog covers English (`en`), Simplified Chinese (`zh-Hans`), Traditional Chinese (`zh-Hant`), Japanese (`ja`), Korean (`ko`), Spanish (`es`), Brazilian Portuguese (`pt-BR`), French (`fr`), and German (`de`). Simplified Chinese is the catalog’s source language.

The current catalog contains **202 translatable keys with complete translations in all nine locales**, plus 10 intentionally nontranslatable entries. The exclusions are the empty extraction key, format-only combinations and separators, and product/file identifiers (`Prompix`, `Prompt`, `Skills`, `Agent Skills`, `SKILL.md`). Obsolete mock artwork lettering has been removed.

## Terminology and behavior

- Prompt, Skill, Agent Skills, Prompix, model names, and file identifiers retain their recognizable spelling. Plural suffixes are used where local grammar calls for them.
- Discover, saved content, creators, filters, and editing states use consistent terminology within each locale. Saved creators are distinct from saved content.
- Copying and editing refer to the current content language; restoring original content and restoring a translation have distinct labels and confirmations.
- Errors say whether data was saved and whether original files or offline previews were preserved. English copy was corrected where previous translations added behavior that the Chinese source did not state.
- Counts for Prompt, characters, content items, and Skill files have `one` and `other` branches in English, Spanish, Brazilian Portuguese, French, and German. Chinese, Japanese, and Korean use count forms that do not vary by grammatical number.
- Accessibility image controls, player states, source links, storage failures, search history, and creator bookmarks are included.
- Creator profile actions label the destination platform in parentheses. The platform placeholder is not translated as the profile’s owner. Generic model families and website-building tools have localized labels; named models keep their identifiers.

## Repeatable checks

Run from the repository root:

```sh
python3 scripts/check-localizations.py
```

The check fails on missing locales, blank values, untranslated states, changed printf placeholder types or counts, missing count plural branches, unexpected exact English fallback, and missing Chinese/Japanese/Korean script. The small allowlist for shared English spellings contains technical names, cognates, and standard acknowledgements; it is not a general fallback exemption.

Checker rejection paths were exercised with temporary modified catalogs: a missing Japanese value, blank Korean string, removed `%@`, an English search label in Spanish, and a removed German singular branch. All five were rejected. The complete catalog passed.

These checks establish catalog completeness and formatting consistency. They do not constitute professional native-speaker review or prove that every translation fits its rendered control. Simulator verification should cover the nine language settings, discover/search, creator profiles and saved creators, Skill details, content-language switching, edit/restore dialogs, accessibility labels, and narrow-width layouts. Xcode build and rendered UI evidence are tracked with release verification.

Content translations have their own pipeline and review; this file describes the app interface catalog.

## 0.3.0 content review evidence

The first-party `studio-005` offline edition contains 30 original items in all nine content locales. Agent review covered all 240 non-source-language prompt bodies and corresponding titles, summaries, examples and constraints; 21 exact corrections were independently rechecked. This is semantic agent review, not professional native-speaker proofreading. Third-party content and review artifacts stay outside Git. Final rendered interface evidence is recorded in [acceptance-0.3.md](acceptance-0.3.md).

The final `Quality-Global-Nine-Languages-7b.xcresult` journey passed in all nine interface locales, searching for one real creator, opening a known work, verifying that the content language follows the interface, and copying it. All 27 actual home/directory/detail screenshots were independently reviewed without a confirmed severe layout defect. This evidence covers standard-size iPhone18Pro simulator rendering; separate small-accessibility/iPad coverage is recorded in the acceptance document.
